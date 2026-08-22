import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TestDataGenerator } from "@/components/TestDataGenerator";
import type { TableSchema } from "@/lib/types";

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

const schema: TableSchema = {
  name: "employees",
  indexes: [],
  columns: [
    { name: "id", type: "SERIAL", nullable: false, isPrimary: true },
    { name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false },
    { name: "name", type: "VARCHAR(100)", nullable: false, isPrimary: false },
    { name: "salary", type: "DECIMAL(10,2)", nullable: true, isPrimary: false },
  ],
};

describe("TestDataGenerator", () => {
  afterEach(() => {
    cleanup();
    if (originalClipboard === undefined) setClipboard(undefined);
    else Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    if (originalExecCommand === undefined) setExecCommand(undefined);
    else Object.defineProperty(globalThis.document, "execCommand", originalExecCommand);
  });

  test("does not render when isOpen is false", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen={false}
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("renders header, row controls, and SQL preview", () => {
    const { queryByText, container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(queryByText("Test Data Generator")).not.toBeNull();
    expect(queryByText("employees")).not.toBeNull();
    expect(queryByText("10")).not.toBeNull();
    expect(container.textContent).toContain("INSERT INTO employees");
  });

  test("quotes a generated value that does not match its column's numeric type", () => {
    // The generator is chosen by column NAME and the quoting by column TYPE, so
    // the two can disagree: `phone BIGINT` produces `+1-555-…`, which used to be
    // written into the statement unquoted because the type said numeric. Same
    // shape as the import defect (PR #304 review) — here it makes broken SQL
    // rather than an injection, because the vocabulary is the generator's own.
    const mismatched: TableSchema = {
      name: "contacts",
      indexes: [],
      columns: [{ name: "phone", type: "BIGINT", nullable: false, isPrimary: false }],
    };
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="contacts"
        tableSchema={mismatched}
        onExecuteQuery={mock(() => {})}
      />,
    );

    const text = container.textContent || "";
    expect(text).toContain("('+1-555-");
    expect(text).not.toContain("(+1-555-");
  });

  test("row count buttons change output", () => {
    const { queryByText, container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    fireEvent.click(queryByText("5")!);
    const text = container.textContent || "";
    expect(text).toContain("INSERT INTO employees");
  });

  test("execute button fires onExecuteQuery and onClose", () => {
    const onExecuteQuery = mock((q: string) => {
      void q;
    });
    const onClose = mock(() => {});
    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={onClose}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("Execute")!);
    expect(onExecuteQuery).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── inferFakerType: email column ────────────────────────────────────────────

  test("inferFakerType maps email column to email generator", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="users"
        tableSchema={{
          name: "users",
          indexes: [],
          columns: [{ name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false }],
        }}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("email: email");
    expect(text).toContain("@example.com");
  });

  // ── inferFakerType: phone column ────────────────────────────────────────────

  test("inferFakerType maps phone column to phone generator", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="contacts"
        tableSchema={{
          name: "contacts",
          indexes: [],
          columns: [{ name: "phone", type: "VARCHAR(20)", nullable: true, isPrimary: false }],
        }}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("phone: phone");
    expect(text).toContain("+1-555-");
  });

  // ── AutoIncrement columns excluded + shown with line-through ────────────────

  test("autoIncrement columns are excluded from SQL and shown with line-through", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    // SQL should NOT include the "id" column in INSERT
    expect(text).not.toContain('"id"');
    // The mapping preview should show "id: autoIncrement" with line-through class
    const spans = container.querySelectorAll("span.line-through");
    expect(spans.length).toBeGreaterThan(0);
    const autoIncrSpan = Array.from(spans).find((s) => s.textContent?.includes("id: autoIncrement"));
    expect(autoIncrSpan).not.toBeNull();
  });

  // ── MongoDB insertMany JSON generation ──────────────────────────────────────

  test("generates MongoDB insertMany JSON when queryLanguage is json", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="users"
        tableSchema={{
          name: "users",
          indexes: [],
          columns: [
            { name: "name", type: "VARCHAR(100)", nullable: false, isPrimary: false },
            { name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false },
          ],
        }}
        queryLanguage="json"
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain('"collection": "users"');
    expect(text).toContain('"operation": "insertMany"');
    expect(text).toContain('"documents"');
    expect(text).not.toContain("INSERT INTO");
  });

  // ── Copy button writes to clipboard ─────────────────────────────────────────

  test("copy button writes generated query to clipboard", () => {
    const mockWriteText = mock(() => Promise.resolve());
    setClipboard({ writeText: mockWriteText });

    const { getByTestId } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    fireEvent.click(getByTestId("test-data-copy"));
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    const arg = (mockWriteText.mock.calls as unknown[][])[0][0] as string;
    expect(arg).toContain("INSERT INTO employees");
  });

  // ── "Copied!" feedback text ─────────────────────────────────────────────────

  test("reports the copy once the write has reported one", async () => {
    setClipboard({ writeText: mock(() => Promise.resolve()) });

    const { getByTestId } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(getByTestId("test-data-copy").textContent).toContain("Copy");
    expect(getByTestId("test-data-copy").textContent).not.toContain("Copied");
    fireEvent.click(getByTestId("test-data-copy"));
    await waitFor(() => expect(getByTestId("test-data-copy").textContent).toContain("Copied"));
  });

  // B43: the flag used to flip in the same statement that started the write, so on the
  // plain-HTTP channels this product ships on it read "Copied!" over an empty clipboard.
  test("does not claim a copy when both write paths refuse", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    const { getByTestId } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    fireEvent.click(getByTestId("test-data-copy"));

    await waitFor(() => expect(getByTestId("test-data-copy").textContent).toContain("Copy failed"));
    expect(getByTestId("test-data-copy").textContent).not.toContain("Copied");
  });

  // ── Regenerate button ───────────────────────────────────────────────────────

  test("regenerate button re-generates data", () => {
    const { queryByText, container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const before = container.querySelector("pre")?.textContent || "";
    fireEvent.click(queryByText("Regenerate")!);
    const after = container.querySelector("pre")?.textContent || "";
    // Both should contain INSERT INTO (still valid SQL)
    expect(before).toContain("INSERT INTO employees");
    expect(after).toContain("INSERT INTO employees");
  });

  // ── Column mapping preview display ──────────────────────────────────────────

  test("shows column mapping preview for each column", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("id: autoIncrement");
    expect(text).toContain("email: email");
    expect(text).toContain("name: fullName");
    expect(text).toContain("salary: price");
  });

  // ── Row count 25 generates 25 rows ─────────────────────────────────────────

  test("selecting row count 25 generates 25 value rows", () => {
    const onExecuteQuery = mock((q: string) => {
      void q;
    });
    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("25")!);
    fireEvent.click(queryByText("Execute")!);
    const sql = onExecuteQuery.mock.calls[0][0] as string;
    // Count the number of value tuples (each starts with '(')
    const tuples = sql.split("\n").filter((line) => line.trim().startsWith("("));
    expect(tuples.length).toBe(25);
  });

  // ── Close button calls onClose ──────────────────────────────────────────────

  test("close button (X) calls onClose", () => {
    const onClose = mock(() => {});
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={onClose}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    // The X close button is the first button in the header
    const closeBtn = container.querySelector("button");
    expect(closeBtn).not.toBeNull();
    // Find the button that contains the X icon — it's the one right after header text
    const allButtons = container.querySelectorAll("button");
    const xButton = Array.from(allButtons).find((btn) => {
      const svg = btn.querySelector("svg");
      return svg && !btn.textContent?.trim();
    });
    expect(xButton).not.toBeNull();
    fireEvent.click(xButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Column/row count in footer ──────────────────────────────────────────────

  test("footer shows correct column and row count", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="employees"
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    // 4 columns total, 1 is autoIncrement (id), so 3 columns shown
    expect(text).toContain("3 columns");
    expect(text).toContain("10 rows");
  });

  // ── Numeric types not quoted in SQL ─────────────────────────────────────────

  test("numeric types are not quoted in SQL output", () => {
    const numericSchema: TableSchema = {
      name: "metrics",
      indexes: [],
      columns: [
        { name: "score", type: "INTEGER", nullable: false, isPrimary: false },
        { name: "rate", type: "DECIMAL(5,2)", nullable: false, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });
    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="metrics"
        tableSchema={numericSchema}
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("Execute")!);
    const sql = onExecuteQuery.mock.calls[0][0] as string;
    // Extract the first value tuple
    const firstRow = sql.split("\n").find((line) => line.trim().startsWith("("));
    expect(firstRow).toBeDefined();
    // Numeric values should appear as bare numbers (no surrounding quotes)
    const values = firstRow!
      .trim()
      .replace(/^\(/, "")
      .replace(/\);?$/, "")
      .split(",")
      .map((v) => v.trim());
    for (const v of values) {
      expect(v).not.toMatch(/^'/);
      expect(v).not.toMatch(/'$/);
    }
  });

  // ── String types quoted in SQL ──────────────────────────────────────────────

  test("string types are quoted with single quotes in SQL output", () => {
    const stringSchema: TableSchema = {
      name: "people",
      indexes: [],
      columns: [
        { name: "name", type: "VARCHAR(100)", nullable: false, isPrimary: false },
        { name: "email", type: "TEXT", nullable: false, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });
    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="people"
        tableSchema={stringSchema}
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("Execute")!);
    const sql = onExecuteQuery.mock.calls[0][0] as string;
    // Extract the first value tuple, strip surrounding parens/comma/semicolon
    const firstRow = sql.split("\n").find((line) => line.trim().startsWith("("));
    expect(firstRow).toBeDefined();
    const inner = firstRow!
      .trim()
      .replace(/^\(/, "")
      .replace(/\)[,;]?\s*$/, "");
    // Split by ', ' outside quotes — here both values are simple quoted strings
    const values = inner.split(/, (?=')/);
    for (const v of values) {
      expect(v).toMatch(/^'/);
      expect(v).toMatch(/'$/);
    }
  });

  // ── Name-based fake generators: address/city/country/zip/state/company/ ───
  // ── subject/description/color/ip ────────────────────────────────────────────

  test("maps location and content columns to their fake generators", () => {
    const richSchema: TableSchema = {
      name: "profiles",
      indexes: [],
      columns: [
        { name: "shipping_address", type: "VARCHAR(255)", nullable: true, isPrimary: false },
        { name: "city", type: "VARCHAR(100)", nullable: true, isPrimary: false },
        { name: "country", type: "VARCHAR(100)", nullable: true, isPrimary: false },
        { name: "zip_code", type: "VARCHAR(20)", nullable: true, isPrimary: false },
        { name: "state", type: "VARCHAR(50)", nullable: true, isPrimary: false },
        { name: "company_name", type: "VARCHAR(255)", nullable: true, isPrimary: false },
        { name: "subject", type: "VARCHAR(255)", nullable: true, isPrimary: false },
        { name: "description", type: "TEXT", nullable: true, isPrimary: false },
        { name: "color", type: "VARCHAR(7)", nullable: true, isPrimary: false },
        { name: "ip", type: "VARCHAR(45)", nullable: true, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });
    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="profiles"
        tableSchema={richSchema}
        queryLanguage="json"
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("Execute")!);
    const raw = onExecuteQuery.mock.calls[0][0] as string;
    const doc = (JSON.parse(raw) as { documents: Record<string, string>[] }).documents[0];

    expect(doc.shipping_address).toMatch(/^\d+ (Main|Oak|Pine|Elm|Maple) St$/);
    expect([
      "New York",
      "Los Angeles",
      "Chicago",
      "Houston",
      "Phoenix",
      "London",
      "Paris",
      "Berlin",
      "Tokyo",
      "Sydney",
    ]).toContain(doc.city);
    expect([
      "United States",
      "United Kingdom",
      "Canada",
      "Germany",
      "France",
      "Japan",
      "Australia",
      "Brazil",
    ]).toContain(doc.country);
    expect(doc.zip_code).toMatch(/^\d{5}$/);
    expect(["California", "New York", "Texas", "Florida", "Illinois", "Pennsylvania", "Ohio", "Georgia"]).toContain(
      doc.state,
    );
    expect([
      "Acme Corp",
      "TechStart",
      "GlobalSync",
      "NovaTech",
      "DataFlow",
      "CloudPeak",
      "ByteWise",
      "NetSphere",
    ]).toContain(doc.company_name);
    expect([
      "Quick update needed",
      "New feature request",
      "Bug fix applied",
      "Performance review",
      "System maintenance",
    ]).toContain(doc.subject);
    expect(doc.description).toContain("Lorem ipsum");
    expect(doc.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(doc.ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  // ── Type-based fake generators: date/timestamp/uuid/json + default fallback ─

  test("maps date, timestamp, uuid, json, and unmatched columns to their fake generators", () => {
    const typedSchema: TableSchema = {
      name: "events",
      indexes: [],
      columns: [
        { name: "birth_date", type: "DATE", nullable: true, isPrimary: false },
        { name: "updated_at", type: "TIMESTAMP", nullable: true, isPrimary: false },
        { name: "record_uuid", type: "UUID", nullable: true, isPrimary: false },
        { name: "metadata", type: "JSON", nullable: true, isPrimary: false },
        { name: "misc_value", type: "CHAR(1)", nullable: true, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });
    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tableName="events"
        tableSchema={typedSchema}
        queryLanguage="json"
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("Execute")!);
    const raw = onExecuteQuery.mock.calls[0][0] as string;
    const doc = (JSON.parse(raw) as { documents: Record<string, string>[] }).documents[0];

    expect(doc.birth_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(doc.record_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(doc.metadata).toBe("{}");
    expect(["Sample text", "Test data", "Example value", "Test content", "Placeholder"]).toContain(doc.misc_value);
  });
});
