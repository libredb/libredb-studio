import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TestDataGenerator } from "@/components/TestDataGenerator";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * The declaration this modal now takes instead of a bare `queryLanguage` string: the
 * generated INSERT names the object's whole ADDRESS, so it needs the dialect's quoting as
 * well as its language (#789, Task 35).
 */
function capsOf(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return { queryLanguage: "sql", ...overrides } as unknown as ProviderCapabilities;
}
// MongoDB's declaration: one container level, the database (`MONGODB_CONTAINER_LEVELS`).
const jsonCaps = capsOf({
  queryLanguage: "json",
  containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
});
const postgresCaps = capsOf({ defaultPort: 5432 });
const mssqlCaps = capsOf({ defaultPort: 1433 });
const oracleCaps = capsOf({ defaultPort: 1521 });

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

const schema: DetailedObject = {
  name: "employees",
  kind: "table",
  path: ["employees"],
  indexes: [],
  columns: [
    { name: "id", type: "SERIAL", nullable: false, isPrimary: true },
    { name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false },
    { name: "name", type: "VARCHAR(100)", nullable: false, isPrimary: false },
    { name: "salary", type: "DECIMAL(10,2)", nullable: true, isPrimary: false },
  ],
};

/**
 * A MySQL/MariaDB reading (#1033): `type` is the type AS DECLARED and `baseType` the family.
 * An `ENUM` carries its VALUES in the declaration, so `enum('int','text')` answers a
 * substring test for `int` and picks a generator that writes numbers into a string column.
 */
const declaredTypeSchema: DetailedObject = {
  name: "lentest",
  kind: "table",
  path: ["lentest"],
  indexes: [],
  columns: [
    { name: "qty", type: "int unsigned", baseType: "int", nullable: true, isPrimary: false },
    { name: "flavour", type: "enum('int','text')", baseType: "enum", nullable: true, isPrimary: false },
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
        tablePath={["employees"]}
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("closed with no object chosen, as StudioModals mounts it, it renders nothing on an InfluxQL connection", () => {
    // The InfluxQL quoting of the empty path threw during this render and took the whole Studio down
    // for every influxdb connection, in the standalone app and in the embedded StudioWorkspace.
    const { container } = render(
      <TestDataGenerator
        isOpen={false}
        onClose={mock(() => {})}
        tablePath={[]}
        tableSchema={null}
        capabilities={capsOf({ queryLanguage: "influxql" })}
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
        tablePath={["employees"]}
        tableSchema={schema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(queryByText("Test Data Generator")).not.toBeNull();
    expect(queryByText("employees")).not.toBeNull();
    expect(queryByText("10")).not.toBeNull();
    expect(container.textContent).toContain("INSERT INTO employees");
  });

  // CQL's INSERT takes one row: on Cassandra 5.0.9 a multi-row VALUES list answered "mismatched input ','
  // expecting EOF" (#1410), so an engine declaring no multi-row insert gets one statement per row.
  test("writes one INSERT per row where the engine declares no multi-row insert", () => {
    const renderWith = (capabilities: ProviderCapabilities): string => {
      const { container } = render(
        <TestDataGenerator
          isOpen
          onClose={mock(() => {})}
          tablePath={["shop", "employees"]}
          tableSchema={schema}
          capabilities={capabilities}
          onExecuteQuery={mock(() => {})}
        />,
      );
      const text = container.textContent ?? "";
      cleanup();
      return text;
    };
    const single = renderWith(capsOf({ defaultPort: 9042, supportsMultiRowInsert: false }));
    const inserts = single.match(/INSERT INTO shop\.employees/g) ?? [];
    expect(inserts.length).toBeGreaterThan(1);
    expect(single.match(/VALUES/g)?.length).toBe(inserts.length);
    expect(single).not.toContain("),");

    const multi = renderWith(postgresCaps);
    expect(multi.match(/INSERT INTO/g)?.length).toBe(1);
    expect(multi).toContain("),");
  });

  test("quotes COLUMN names the way the connected engine reads an identifier", () => {
    // The target moved onto `quoteObjectPath` (#789) while the column list kept a
    // hardcoded `"`, so the two halves of one statement spoke different dialects.
    // A column whose name needs quoting is what separates them: MySQL backticks it,
    // SQL Server brackets it, and `"order date"` is what MySQL reads as a string
    // literal rather than a column, so the INSERT did not parse at all.
    const awkward: DetailedObject = {
      ...schema,
      columns: [{ name: "order date", type: "VARCHAR(50)", nullable: false, isPrimary: false }],
    };
    const render1 = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "employees"]}
        tableSchema={awkward}
        capabilities={capsOf({ defaultPort: 3306 })}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const mysql = render1.container.textContent ?? "";
    expect(mysql).toContain("`order date`");
    expect(mysql).not.toContain('"order date"');
    cleanup();

    // The control: the same column, a different engine, a different spelling. Without
    // it the assertion above would pass for a component that quoted nothing at all.
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "employees"]}
        tableSchema={awkward}
        capabilities={mssqlCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(container.textContent ?? "").toContain("[order date]");
  });

  test("quotes a generated value that does not match its column's numeric type", () => {
    // The generator is chosen by column NAME and the quoting by column TYPE, so
    // the two can disagree: `phone BIGINT` produces `+1-555-…`, which used to be
    // written into the statement unquoted because the type said numeric. Same
    // shape as the import defect (PR #304 review) — here it makes broken SQL
    // rather than an injection, because the vocabulary is the generator's own.
    const mismatched: DetailedObject = {
      name: "contacts",
      kind: "table",
      path: ["contacts"],
      indexes: [],
      columns: [{ name: "phone", type: "BIGINT", nullable: false, isPrimary: false }],
    };
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["contacts"]}
        tableSchema={mismatched}
        onExecuteQuery={mock(() => {})}
      />,
    );

    const text = container.textContent || "";
    expect(text).toContain("('+1-555-");
    expect(text).not.toContain("(+1-555-");
  });

  test("quotes a numeric-looking value for an ENUM whose values spell a number type (#1033)", () => {
    // The mirror of the test above: here the VALUE is honest and the TYPE misleads. MySQL
    // reports `enum('int','x')` in `type`, which a substring test reads as an integer column,
    // so the `age` generator's number went into the statement bare. Measured on MySQL 26.7.0,
    // a bare number into an ENUM is an INDEX into its value list: `1` silently stores 'int',
    // and `42` is error 1265. The family in `baseType` is `enum`, so the value is quoted.
    const enumAge: DetailedObject = {
      name: "people",
      kind: "table",
      path: ["people"],
      indexes: [],
      columns: [{ name: "age", type: "enum('int','x')", baseType: "enum", nullable: true, isPrimary: false }],
    };
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["people"]}
        tableSchema={enumAge}
        onExecuteQuery={mock(() => {})}
      />,
    );

    const text = container.textContent || "";
    expect(text).toMatch(/\('\d+'\)/);
    expect(text).not.toMatch(/\(\d+\)/);
  });

  test("row count buttons change output", () => {
    const { queryByText, container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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
        tablePath={["shop", "users"]}
        tableSchema={{
          name: "users",
          kind: "table",
          path: ["shop", "users"],
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
        tablePath={["contacts"]}
        tableSchema={{
          name: "contacts",
          kind: "table",
          path: ["contacts"],
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
        tablePath={["employees"]}
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
        tablePath={["shop", "users"]}
        tableSchema={{
          name: "users",
          kind: "table",
          path: ["shop", "users"],
          indexes: [],
          columns: [
            { name: "name", type: "VARCHAR(100)", nullable: false, isPrimary: false },
            { name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false },
          ],
        }}
        capabilities={jsonCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    // The database rides as its own key (#843): without it the insert landed in the
    // connected database's same-named collection, a write to the wrong place.
    expect(text).toContain('"database": "shop"');
    expect(text).toContain('"collection": "users"');
    expect(text).toContain('"operation": "insertMany"');
    expect(text).toContain('"documents"');
    expect(text).not.toContain("INSERT INTO");
  });

  test("rebuilds MongoDB dotted columns as nested documents", () => {
    const nestedSchema: DetailedObject = {
      name: "customers",
      kind: "table",
      path: ["shop", "customers"],
      indexes: [],
      columns: [
        { name: "_id", type: "OBJECTID", nullable: false, isPrimary: true },
        { name: "name", type: "VARCHAR(100)", nullable: false, isPrimary: false },
        { name: "address", type: "object", nullable: true, isPrimary: false },
        { name: "address.city", type: "VARCHAR(100)", nullable: true, isPrimary: false },
        { name: "address.geo", type: "object", nullable: true, isPrimary: false },
        { name: "address.geo.lat", type: "DOUBLE", nullable: true, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });

    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "customers"]}
        tableSchema={nestedSchema}
        capabilities={jsonCaps}
        onExecuteQuery={onExecuteQuery}
      />,
    );

    fireEvent.click(queryByText("Execute")!);
    const raw = onExecuteQuery.mock.calls[0][0] as string;
    const doc = (JSON.parse(raw) as { documents: Record<string, unknown>[] }).documents[0];
    const address = doc.address as Record<string, unknown>;
    const geo = address.geo as Record<string, unknown>;

    expect(address.city).toBeDefined();
    expect(geo.lat).toBeDefined();
    expect(Object.keys(doc).some((key) => key.includes("."))).toBe(false);
    expect(doc.address).not.toBe("value_0");
  });

  test("treats __proto__ as a normal MongoDB field", () => {
    const nestedSchema: DetailedObject = {
      name: "profiles",
      kind: "table",
      path: ["shop", "profiles"],
      indexes: [],
      columns: [
        { name: "__proto__", type: "object", nullable: true, isPrimary: false },
        { name: "__proto__.isAdmin", type: "BOOLEAN", nullable: true, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();

    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "profiles"]}
        tableSchema={nestedSchema}
        capabilities={jsonCaps}
        onExecuteQuery={onExecuteQuery}
      />,
    );

    fireEvent.click(queryByText("Execute")!);
    const raw = onExecuteQuery.mock.calls[0][0] as string;
    const doc = (JSON.parse(raw) as { documents: Record<string, unknown>[] }).documents[0];

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(doc).toHaveProperty("__proto__");
    expect(doc["__proto__"]).toEqual({ isAdmin: expect.any(Boolean) });
  });

  test("generates an empty object for a standalone MongoDB object field", () => {
    const nestedSchema: DetailedObject = {
      name: "profiles",
      kind: "table",
      path: ["shop", "profiles"],
      indexes: [],
      columns: [{ name: "metadata", type: "object", nullable: true, isPrimary: false }],
    };
    const onExecuteQuery = mock((q: string) => {
      void q;
    });

    const { queryByText } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "profiles"]}
        tableSchema={nestedSchema}
        capabilities={jsonCaps}
        onExecuteQuery={onExecuteQuery}
      />,
    );

    fireEvent.click(queryByText("Execute")!);
    const raw = onExecuteQuery.mock.calls[0][0] as string;
    const doc = (JSON.parse(raw) as { documents: Record<string, unknown>[] }).documents[0];

    expect(doc.metadata).toEqual({});
  });

  // ── Copy button writes to clipboard ─────────────────────────────────────────

  test("copy button writes generated query to clipboard", () => {
    const mockWriteText = mock(() => Promise.resolve());
    setClipboard({ writeText: mockWriteText });

    const { getByTestId } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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

  test("picks a generator from the type FAMILY, not the declaration (#1033)", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["lentest"]}
        tableSchema={declaredTypeSchema}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    // `int unsigned` IS an integer and `enum('int','text')` is not, and the declaration alone
    // cannot say so.
    expect(text).toContain("qty: integer");
    expect(text).toContain("flavour: text");
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
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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
        tablePath={["employees"]}
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
    const numericSchema: DetailedObject = {
      name: "metrics",
      kind: "table",
      path: ["metrics"],
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
        tablePath={["metrics"]}
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
    const stringSchema: DetailedObject = {
      name: "people",
      kind: "table",
      path: ["people"],
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
        tablePath={["people"]}
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
    const richSchema: DetailedObject = {
      name: "profiles",
      kind: "table",
      path: ["shop", "profiles"],
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
        tablePath={["shop", "profiles"]}
        tableSchema={richSchema}
        capabilities={jsonCaps}
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
    const typedSchema: DetailedObject = {
      name: "events",
      kind: "table",
      path: ["shop", "events"],
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
        tablePath={["shop", "events"]}
        tableSchema={typedSchema}
        capabilities={jsonCaps}
        onExecuteQuery={onExecuteQuery}
      />,
    );
    fireEvent.click(queryByText("Execute")!);
    const raw = onExecuteQuery.mock.calls[0][0] as string;
    const doc = (JSON.parse(raw) as { documents: Record<string, unknown>[] }).documents[0];

    // A date and a UUID are written as the Extended JSON the provider reads into those BSON types (#1468).
    expect(doc.birth_date).toEqual({ $date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(doc.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(doc.record_uuid).toEqual({
      $uuid: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    });
    expect(doc.metadata).toBe("{}");
    expect(["Sample text", "Test data", "Example value", "Test content", "Placeholder"]).toContain(
      doc.misc_value as string,
    );
  });

  // ── The address the statement names (#789, Task 35) ────────────────────────
  //
  // This modal's product is a statement it can RUN. `INSERT INTO customers` is not a
  // statement about the object that was clicked wherever two containers hold that label -
  // measured live on SQL Server, which holds `libredb_objects.app.customers` and
  // `shop.dbo.customers` - so it wrote rows into whichever one the connection defaulted to.

  const customers: DetailedObject = {
    name: "customers",
    kind: "table",
    path: ["shop", "dbo", "customers"],
    indexes: [],
    columns: [{ name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false }],
  };

  test("names the object's whole address, not its label", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "dbo", "customers"]}
        tableSchema={customers}
        capabilities={mssqlCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("INSERT INTO shop.dbo.customers (");
    expect(text).not.toContain("INSERT INTO customers (");
  });

  test("quotes per segment, so a name containing a dot cannot become a qualifier", () => {
    const dotted: DetailedObject = { ...customers, name: "a.b", path: ["demo", "a.b"] };
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["demo", "a.b"]}
        tableSchema={dotted}
        capabilities={postgresCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(container.textContent || "").toContain('INSERT INTO demo."a.b" (');
  });

  test("with no declaration yet, the address is still qualified rather than bare", () => {
    // `provider-meta` has not answered. The dotted spelling is what `useTabManager` writes
    // in the same position: a qualified address is valid wherever the bare label is, and the
    // bare label is the one reading that can address another container's table.
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["shop", "dbo", "customers"]}
        tableSchema={customers}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("INSERT INTO shop.dbo.customers (");
    expect(text).not.toContain("INSERT INTO customers (");
  });

  test("MongoDB takes the collection's own segment, not the joined address", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={["sample_shop", "customers"]}
        tableSchema={{ ...customers, path: ["sample_shop", "customers"] }}
        capabilities={jsonCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain('"collection": "customers"');
    // The header does name the address; the STATEMENT must not, because the driver is
    // connected to the database already.
    expect(text).not.toContain('"collection": "sample_shop');
  });
});

/**
 * A deterministic `Math.random` and clock, so a generated statement can be compared byte for byte.
 * A small linear congruential generator rather than a short cycle, so no two rows repeat.
 */
function withDeterministicRandom<T>(run: () => T): T {
  let seed = 1468;
  const random = spyOn(Math, "random").mockImplementation(() => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  });
  const now = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 6, 12, 0, 0));
  try {
    return run();
  } finally {
    random.mockRestore();
    now.mockRestore();
  }
}

/** Renders the dialog and returns the statement Execute hands over. */
function executed(
  tableSchema: DetailedObject,
  capabilities: ProviderCapabilities | undefined,
  databaseType: string = capabilities === jsonCaps ? "mongodb" : "postgres",
): string {
  const onExecuteQuery = mock((query: string) => {
    void query;
  });
  const { queryByText } = render(
    <TestDataGenerator
      isOpen
      onClose={mock(() => {})}
      tablePath={tableSchema.path}
      tableSchema={tableSchema}
      databaseType={databaseType}
      capabilities={capabilities}
      onExecuteQuery={onExecuteQuery}
    />,
  );
  fireEvent.click(queryByText("Execute")!);
  return onExecuteQuery.mock.calls[0][0] as string;
}

describe("TestDataGenerator value typing (#1468)", () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * Every SQL column the JSON arm's rules could have reached, dotted names included: in SQL a dot is
   * part of a quoted column name and never a document path, so `address.zip` keeps the `address`
   * generator it always had. The expected text was captured from the generator before #1468 changed
   * the JSON arm, so any change to the SQL arm's output fails here.
   */
  const sqlEverything: DetailedObject = {
    name: "everything",
    kind: "table",
    path: ["public", "everything"],
    indexes: [],
    columns: [
      { name: "id", type: "SERIAL", nullable: false, isPrimary: true },
      { name: "address.zip", type: "VARCHAR(20)", nullable: true, isPrimary: false },
      { name: "geo.lat", type: "DOUBLE PRECISION", nullable: true, isPrimary: false },
      { name: "email", type: "VARCHAR(255)", nullable: false, isPrimary: false },
      { name: "city", type: "TEXT", nullable: true, isPrimary: false },
      { name: "active", type: "BOOLEAN", nullable: true, isPrimary: false },
      { name: "qty", type: "INTEGER", nullable: true, isPrimary: false },
      { name: "price", type: "NUMERIC(10,2)", nullable: true, isPrimary: false },
      { name: "born", type: "DATE", nullable: true, isPrimary: false },
      { name: "created_at", type: "TIMESTAMP", nullable: true, isPrimary: false },
      { name: "ref", type: "UUID", nullable: true, isPrimary: false },
      { name: "tags", type: "TEXT[]", nullable: true, isPrimary: false },
      { name: "meta", type: "JSONB", nullable: true, isPrimary: false },
    ],
  };

  test("the SQL arm's statement is byte for byte what it was before the JSON arm was typed", () => {
    const statement = withDeterministicRandom(() => executed(sqlEverything, postgresCaps));
    expect(statement).toBe(SQL_EVERYTHING_BEFORE_1468);
  });

  test("a dotted SQL column keeps the generator its whole name picks", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={sqlEverything.path}
        tableSchema={sqlEverything}
        capabilities={postgresCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    expect(container.textContent).toContain("address.zip: address");
  });

  /** A collection as `inferSchemaFromDocuments` reports it, with its own type spellings. */
  const customers: DetailedObject = {
    name: "customers",
    kind: "collection",
    path: ["shop", "customers"],
    indexes: [],
    columns: [
      { name: "_id", type: "objectId", nullable: false, isPrimary: true },
      { name: "address", type: "object", nullable: true, isPrimary: false },
      { name: "address.city", type: "string", nullable: true, isPrimary: false },
      { name: "address.zip", type: "string", nullable: true, isPrimary: false },
      { name: "address.street", type: "string", nullable: true, isPrimary: false },
      { name: "address.geo", type: "object", nullable: true, isPrimary: false },
      { name: "address.geo.lat", type: "number", nullable: true, isPrimary: false },
      { name: "email", type: "string", nullable: true, isPrimary: false },
    ],
  };

  test("a dotted MongoDB path picks its generator by its leaf, not by an ancestor's name", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={customers.path}
        tableSchema={customers}
        capabilities={jsonCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    // Before #1468 every one of these matched the `address` name rule and got a street address.
    expect(text).toContain("address.city: city");
    expect(text).toContain("address.zip: zipCode");
    expect(text).toContain("address.street: address");
    expect(text).toContain("address.geo.lat: integer");
    expect(text).toContain("email: email");
  });

  test("a dotted MongoDB path is generated from its leaf's generator", () => {
    const doc = (
      JSON.parse(withDeterministicRandom(() => executed(customers, jsonCaps))) as {
        documents: Record<string, Record<string, unknown>>[];
      }
    ).documents[0];
    const address = doc.address;
    expect(address.street).toMatch(/^\d+ \w+ St$/);
    expect(address.city).not.toMatch(/ St$/);
    expect(address.zip).toMatch(/^\d{5}$/);
    expect(typeof (address.geo as Record<string, unknown>).lat).toBe("number");
    // `_id` is left to the server, as the SQL arm leaves a serial column to the engine.
    expect(doc).not.toHaveProperty("_id");
  });

  /** One field per type spelling `getMongoType` answers that the dialog writes a typed value for. */
  const typed: DetailedObject = {
    name: "typed",
    kind: "collection",
    path: ["shop", "typed"],
    indexes: [],
    columns: [
      { name: "qty", type: "number", nullable: true, isPrimary: false },
      { name: "price", type: "number", nullable: true, isPrimary: false },
      { name: "phone", type: "number", nullable: true, isPrimary: false },
      { name: "count", type: "int", nullable: true, isPrimary: false },
      { name: "ratio", type: "double", nullable: true, isPrimary: false },
      { name: "views", type: "long", nullable: true, isPrimary: false },
      { name: "balance", type: "decimal", nullable: true, isPrimary: false },
      { name: "active", type: "boolean", nullable: true, isPrimary: false },
      { name: "tags", type: "array", nullable: true, isPrimary: false },
      { name: "createdAt", type: "date", nullable: true, isPrimary: false },
      { name: "owner", type: "objectId", nullable: true, isPrimary: false },
      { name: "ref", type: "uuid", nullable: true, isPrimary: false },
      { name: "gone", type: "null", nullable: true, isPrimary: false },
      { name: "note", type: "mixed(null|string)", nullable: true, isPrimary: false },
      { name: "score", type: "mixed(undefined|number|string)", nullable: true, isPrimary: false },
      { name: "nothing", type: "mixed(null|undefined)", nullable: true, isPrimary: false },
      { name: "pattern", type: "regex", nullable: true, isPrimary: false },
    ],
  };

  test("MongoDB values are written in the JSON type their inferred field type names", () => {
    const docs = (JSON.parse(executed(typed, jsonCaps)) as { documents: Record<string, unknown>[] }).documents;
    expect(docs).toHaveLength(10);
    for (const doc of docs) {
      expect(typeof doc.qty).toBe("number");
      expect(Number.isInteger(doc.qty)).toBe(true);
      expect(typeof doc.price).toBe("number");
      // A name generator whose text is not a number gives way to the field's own type.
      expect(typeof doc.phone).toBe("number");
      expect(Number.isInteger(doc.count)).toBe(true);
      expect(typeof doc.ratio).toBe("number");
      expect(doc.views).toEqual({ $numberLong: expect.stringMatching(/^\d+$/) });
      expect(doc.balance).toEqual({ $numberDecimal: expect.stringMatching(/^\d+\.\d{2}$/) });
      expect(typeof doc.active).toBe("boolean");
      expect(doc.tags).toEqual([]);
      const createdAt = doc.createdAt as { $date: string };
      expect(Object.keys(createdAt)).toEqual(["$date"]);
      expect(Number.isNaN(Date.parse(createdAt.$date))).toBe(false);
      expect(createdAt.$date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(doc.owner).toEqual({ $oid: expect.stringMatching(/^[0-9a-f]{24}$/) });
      expect(doc.ref).toEqual({
        $uuid: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      });
      expect(doc.gone).toBeNull();
      expect(typeof doc.note).toBe("string");
      expect(typeof doc.score).toBe("number");
      expect(doc.nothing).toBeNull();
      // A type with no typed spelling here keeps the text value it always had.
      expect(typeof doc.pattern).toBe("string");
    }
  });

  test("MongoDB ObjectId and UUID values come from crypto.getRandomValues, not Math.random", () => {
    const original = Math.random;
    Math.random = () => 0;
    try {
      const docs = (JSON.parse(executed(typed, jsonCaps)) as { documents: Record<string, unknown>[] }).documents;
      const oids = new Set(docs.map((doc) => (doc.owner as { $oid: string }).$oid));
      const uuids = new Set(docs.map((doc) => (doc.ref as { $uuid: string }).$uuid));
      expect(oids.size).toBe(docs.length);
      expect(uuids.size).toBe(docs.length);
      for (const uuid of uuids) {
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    } finally {
      Math.random = original;
    }
  });

  test("the column chips name the generator each MongoDB value is written with", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={typed.path}
        tableSchema={typed}
        capabilities={jsonCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("qty: integer");
    expect(text).toContain("price: price");
    expect(text).toContain("phone: integer");
    expect(text).toContain("ratio: decimal");
    expect(text).toContain("active: boolean");
    expect(text).toContain("tags: array");
    expect(text).toContain("createdAt: datetime");
    expect(text).toContain("owner: objectId");
    expect(text).toContain("ref: uuid");
    expect(text).toContain("gone: null");
  });
});

const SQL_EVERYTHING_BEFORE_1468 = [
  'INSERT INTO public.everything ("address.zip", "geo.lat", email, city, active, qty, price, born, created_at, ref, tags, meta)',
  "VALUES",
  "  ('100 Oak St', 877.24, 'user1@example.com', 'London', true, 7897, 271.39, '2026-04-18', '2025-12-17 16:51:09', 'c8f14acf-8414-4c79-a317-7c5479e9d9f7', 'Sample text', '{}'),",
  "  ('200 Maple St', 186.30, 'user2@example.com', 'Chicago', true, 9269, 968.47, '2025-11-11', '2026-08-25 04:26:46', '6a56b0f2-84dc-4c73-806d-1ff3ffa79cd1', 'Test data', '{}'),",
  "  ('300 Elm St', 815.66, 'user3@example.com', 'Tokyo', false, 2207, 166.56, '2026-07-14', '2026-05-12 08:35:11', '4c20d6f5-0601-4aab-9eae-8117f063d979', 'Sample text', '{}'),",
  "  ('400 Oak St', 112.23, 'user4@example.com', 'London', true, 4658, 944.72, '2026-05-29', '2026-03-22 06:19:26', '110a9192-4f10-4ebd-a7e2-e55f0514120a', 'Test data', '{}'),",
  "  ('500 Maple St', 385.34, 'user5@example.com', 'Los Angeles', false, 7661, 62.15, '2026-04-21', '2026-04-13 00:05:38', 'b63dd27d-a3ef-4143-a4ae-53a97afc5b80', 'Example value', '{}'),",
  "  ('600 Main St', 317.50, 'user6@example.com', 'London', true, 6378, 431.86, '2026-06-30', '2026-07-22 04:39:24', '7ec9df1a-3f31-4376-9359-32493e9e15d4', 'Example value', '{}'),",
  "  ('700 Oak St', 315.43, 'user7@example.com', 'Sydney', true, 3984, 206.11, '2026-01-27', '2026-03-26 10:55:41', '2122e045-40c7-4d68-8b64-8485ab416e45', 'Sample text', '{}'),",
  "  ('800 Elm St', 604.01, 'user8@example.com', 'London', false, 2995, 621.84, '2026-04-01', '2026-03-26 10:05:48', '5435446f-5577-4f4c-8b2a-09e2aeb103ce', 'Test data', '{}'),",
  "  ('900 Pine St', 670.53, 'user9@example.com', 'Sydney', true, 293, 387.18, '2026-02-15', '2026-06-05 07:36:01', '2f0f31ca-24f8-467d-86b4-7bb10a7b6274', 'Test data', '{}'),",
  "  ('1000 Elm St', 800.76, 'user10@example.com', 'Berlin', false, 9696, 390.98, '2026-07-05', '2026-08-14 05:52:04', 'be2fe558-2ff0-4123-9174-763827c9f36e', 'Test data', '{}');",
].join("\n");

describe("TestDataGenerator foreign keys and unique columns (#1400)", () => {
  afterEach(() => {
    cleanup();
  });

  const column = (name: string, type: string, extra: Partial<DetailedObject["columns"][number]> = {}) => ({
    name,
    type,
    nullable: true,
    isPrimary: false,
    ...extra,
  });

  const employees: DetailedObject = {
    name: "emp",
    kind: "table",
    path: ["app", "emp"],
    indexes: [],
    columns: [
      column("id", "serial", { nullable: false, isPrimary: true }),
      column("name", "varchar(100)"),
      column("dept_id", "int"),
      column("manager", "int"),
    ],
    foreignKeys: [
      { columnName: "dept_id", referencedTable: "dept", referencedColumn: "id" },
      { columnName: "manager", referencedTable: "emp", referencedColumn: "id" },
    ],
  };

  function renderGenerator(tableSchema: DetailedObject) {
    return render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={tableSchema.path}
        tableSchema={tableSchema}
        databaseType="postgres"
        capabilities={postgresCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
  }

  test("a foreign key column is left out of the INSERT, whatever its name", () => {
    const statement = executed(employees, postgresCaps);
    expect(statement).toContain("(name)");
    expect(statement).not.toContain("dept_id");
    expect(statement).not.toContain("manager");
  });

  test("a foreign key column is labelled as one, not as auto-increment, and the dialog says why", () => {
    const { container } = renderGenerator(employees);
    const text = container.textContent || "";
    expect(text).toContain("dept_id: foreignKey");
    expect(text).toContain("manager: foreignKey");
    expect(text).not.toContain("dept_id: autoIncrement");
    expect(text).toContain("Foreign key columns are left out of the INSERT (dept_id, manager)");
    expect(text).toContain("1 columns");
    const struck = Array.from(container.querySelectorAll("span.line-through")).map((s) => s.textContent);
    expect(struck).toContain("dept_id: foreignKey");
  });

  test("a table with no foreign keys shows no foreign key note", () => {
    const { container } = renderGenerator({ ...employees, foreignKeys: undefined });
    expect(container.textContent).not.toContain("Foreign key columns are left out");
  });

  const accounts: DetailedObject = {
    name: "accounts",
    kind: "table",
    path: ["app", "accounts"],
    indexes: [
      { name: "accounts_email_key", columns: ["email"], unique: true },
      { name: "accounts_nick_idx", columns: ["nick"], unique: false },
      { name: "accounts_pair_key", columns: ["handle", "age"], unique: true },
    ],
    columns: [
      column("code", "varchar(20)", { nullable: false, isPrimary: true }),
      column("email", "varchar(255)"),
      column("handle", "varchar(40)", { baseType: "varchar" }),
      column("age", "int"),
      column("nick", "varchar(40)"),
      column("website", "varchar(255)"),
    ],
  };

  const emailsOf = (statement: string): string[] => statement.match(/'user\d+(?:\.[0-9a-f]{6})?@example\.com'/g) ?? [];

  test("emails of a UNIQUE column are distinct within a run and across runs", () => {
    const first = emailsOf(executed(accounts, postgresCaps));
    cleanup();
    const second = emailsOf(executed(accounts, postgresCaps));
    expect(first).toHaveLength(10);
    for (const email of first) expect(email).toMatch(/^'user\d+\.[0-9a-f]{6}@example\.com'$/);
    expect(new Set(first).size).toBe(10);
    expect(first.filter((email) => second.includes(email))).toEqual([]);
  });

  test("Regenerate gives the UNIQUE column new values", () => {
    const { container, getByTitle } = renderGenerator(accounts);
    const before = emailsOf(container.textContent || "");
    fireEvent.click(getByTitle("Regenerate random data"));
    const after = emailsOf(container.textContent || "");
    expect(after).toHaveLength(10);
    expect(after.filter((email) => before.includes(email))).toEqual([]);
  });

  test("free-text values of unique and primary key columns carry a per-run, per-row suffix", () => {
    const statement = withDeterministicRandom(() => executed(accounts, postgresCaps));
    const suffixed = statement.match(/'[^']*-[0-9a-f]{6}-\d+'/g) ?? [];
    // `code` is the primary key and `handle` sits in a unique index: 10 rows each. `website` and
    // `nick` are in no unique index, so they stay what they were.
    expect(suffixed).toHaveLength(20);
    expect(statement).toContain("'https://example.com/page/1'");
    expect(statement).not.toContain("page/1-");
  });

  test("a numeric column of a unique index is not given a text suffix", () => {
    const statement = executed(accounts, postgresCaps);
    expect(statement).not.toMatch(/\d-[0-9a-f]{6}-\d/);
    expect(statement).toMatch(/', \d{2}, '/);
  });

  test("a column in no unique index keeps the plain email", () => {
    const plain: DetailedObject = { ...accounts, indexes: [] };
    const statement = executed({ ...plain, columns: [column("email", "varchar(255)")] }, postgresCaps);
    expect(statement).toContain("'user1@example.com'");
    expect(statement).toContain("'user10@example.com'");
  });

  test("short pick-list values of a UNIQUE column are distinct within one run", () => {
    // Every pick lands on the first entry, the worst case for a short list: without a suffix all
    // ten rows would carry the same city, country, status and paragraph.
    const random = spyOn(Math, "random").mockReturnValue(0);
    try {
      const places: DetailedObject = {
        name: "places",
        kind: "table",
        path: ["app", "places"],
        indexes: [
          { name: "places_city_key", columns: ["city"], unique: true },
          { name: "places_country_key", columns: ["country"], unique: true },
          { name: "places_status_key", columns: ["status"], unique: true },
          { name: "places_description_key", columns: ["description"], unique: true },
        ],
        columns: [
          column("city", "varchar(50)"),
          column("country", "varchar(50)"),
          column("status", "varchar(20)"),
          column("description", "text", { baseType: "text" }),
        ],
      };
      const rows = executed(places, postgresCaps)
        .split("\n")
        .filter((line) => line.startsWith("  ("));
      expect(rows).toHaveLength(10);
      for (let position = 0; position < 4; position++) {
        const values = rows.map((row) => row.match(/'[^']*'/g)![position]);
        expect(new Set(values).size).toBe(10);
      }
    } finally {
      random.mockRestore();
    }
  });

  const mongoUsers = (indexes: DetailedObject["indexes"]): DetailedObject => ({
    name: "users",
    kind: "table",
    path: ["shop", "users"],
    indexes,
    columns: [column("name", "VARCHAR(100)"), column("email", "VARCHAR(255)"), column("age", "int")],
  });

  const mongoEmails = (schema: DetailedObject): string[] =>
    (JSON.parse(executed(schema, jsonCaps)).documents as { email: string }[]).map((doc) => doc.email);

  test("the MongoDB insertMany arm gives a UNIQUE index's field distinct values, within a run and between runs", () => {
    const schema = mongoUsers([{ name: "email_1", columns: ["email"], unique: true }]);
    const first = mongoEmails(schema);
    cleanup();
    const second = mongoEmails(schema);
    for (const email of first) expect(email).toMatch(/^user\d+\.[0-9a-f]{6}@example\.com$/);
    expect(new Set(first).size).toBe(10);
    expect(first.filter((email) => second.includes(email))).toEqual([]);
  });

  test("the MongoDB insertMany arm keeps the plain email where no unique index names the field", () => {
    const emails = mongoEmails(mongoUsers([{ name: "email_1", columns: ["email"], unique: false }]));
    expect(emails[0]).toBe("user1@example.com");
    expect(emails[9]).toBe("user10@example.com");
  });

  /**
   * Math.random answers every value twice in a row, so each row's first draw repeats the row
   * before it: a generator that does not look at what the column already holds writes duplicates.
   */
  function pairedRandom() {
    let calls = 0;
    return spyOn(Math, "random").mockImplementation(() => Math.floor(calls++ / 2) / 100);
  }

  test("a numeric UNIQUE column is distinct within one run even where the draws repeat", () => {
    const random = pairedRandom();
    try {
      const stock: DetailedObject = {
        name: "stock",
        kind: "table",
        path: ["app", "stock"],
        indexes: [{ name: "stock_qty_key", columns: ["qty"], unique: true }],
        columns: [column("qty", "int")],
      };
      const quantities = executed(stock, postgresCaps)
        .split("\n")
        .filter((line) => line.startsWith("  ("))
        .map((line) => line.replace(/[,;]$/, ""));
      expect(quantities).toHaveLength(10);
      expect(new Set(quantities).size).toBe(10);
    } finally {
      random.mockRestore();
    }
  });

  test("the MongoDB insertMany arm gives a numeric UNIQUE index's field distinct values within one run", () => {
    const random = pairedRandom();
    try {
      const ages = (
        JSON.parse(executed(mongoUsers([{ name: "age_1", columns: ["age"], unique: true }]), jsonCaps)).documents as {
          age: number;
        }[]
      ).map((doc) => doc.age);
      expect(ages).toHaveLength(10);
      expect(new Set(ages).size).toBe(10);
    } finally {
      random.mockRestore();
    }
  });

  test("a UNIQUE column whose generator has only two values gives up after a few draws instead of looping", () => {
    const flags: DetailedObject = {
      name: "flags",
      kind: "table",
      path: ["app", "flags"],
      indexes: [{ name: "flags_active_key", columns: ["active"], unique: true }],
      columns: [column("active", "boolean")],
    };
    const rows = executed(flags, postgresCaps)
      .split("\n")
      .filter((line) => line.startsWith("  ("))
      .map((line) => line.replace(/[,;]$/, ""));
    expect(rows).toHaveLength(10);
    expect(new Set(rows).size).toBeLessThanOrEqual(2);
  });
});

describe("TestDataGenerator Oracle literals (#1400)", () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * `APP.EMP` as the Oracle provider reports it: `type` is the declaration and `baseType` is
   * `DATA_TYPE` where the two differ, so `NUMBER(10,2)` and `NUMBER(5)` both reach the generator
   * as `NUMBER` and the scale is not in view. `DATE` and `TIMESTAMP(6)` carry no `baseType`.
   */
  const emp: DetailedObject = {
    name: "EMP",
    kind: "table",
    path: ["APP", "EMP"],
    indexes: [],
    columns: [
      { name: "NAME", type: "VARCHAR2(100 BYTE)", baseType: "VARCHAR2", nullable: false, isPrimary: false },
      { name: "SALARY", type: "NUMBER(10,2)", baseType: "NUMBER", nullable: true, isPrimary: false },
      { name: "QTY", type: "NUMBER(5)", baseType: "NUMBER", nullable: true, isPrimary: false },
      { name: "RATIO", type: "NUMBER", nullable: true, isPrimary: false },
      { name: "HIRED", type: "DATE", nullable: true, isPrimary: false },
      { name: "UPDATED", type: "TIMESTAMP(6)", nullable: true, isPrimary: false },
    ],
  };

  test("a NUMBER column is generated as a number and written unquoted", () => {
    const { container } = render(
      <TestDataGenerator
        isOpen
        onClose={mock(() => {})}
        tablePath={emp.path}
        tableSchema={emp}
        databaseType="oracle"
        capabilities={oracleCaps}
        onExecuteQuery={mock(() => {})}
      />,
    );
    const text = container.textContent || "";
    expect(text).toContain("QTY: integer");
    expect(text).toContain("RATIO: integer");
    expect(text).toContain("SALARY: price");
    cleanup();
    const statement = executed(emp, oracleCaps, "oracle");
    // NAME quoted, then SALARY, QTY and RATIO as bare numbers: before #1400 SALARY was
    // `'88.24'` and QTY and RATIO were `'Sample text'`, which is ORA-01722 on a NUMBER.
    const rows = statement.split("\n").filter((line) => line.startsWith("  ("));
    expect(rows).toHaveLength(10);
    for (const row of rows) expect(row).toMatch(/^ {2}\('[^']+', \d+\.\d{2}, \d+, \d+, TO_DATE\(/);
  });

  test("a DATE value is written through TO_DATE and a TIMESTAMP through TO_TIMESTAMP", () => {
    const statement = executed(emp, oracleCaps, "oracle");
    expect(statement.match(/TO_DATE\('\d{4}-\d{2}-\d{2}', 'YYYY-MM-DD'\)/g)).toHaveLength(10);
    expect(
      statement.match(/TO_TIMESTAMP\('\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', 'YYYY-MM-DD HH24:MI:SS'\)/g),
    ).toHaveLength(10);
    // No date reaches the statement as the quoted text Oracle refuses (ORA-01861).
    expect(statement).not.toMatch(/, '\d{4}-\d{2}-\d{2}/);
  });

  test("every other dialect keeps writing a date and a timestamp as quoted text", () => {
    const events: DetailedObject = {
      name: "events",
      kind: "table",
      path: ["public", "events"],
      indexes: [],
      columns: [
        { name: "on_day", type: "date", nullable: true, isPrimary: false },
        { name: "at", type: "timestamp without time zone", nullable: true, isPrimary: false },
      ],
    };
    const statement = executed(events, postgresCaps);
    expect(statement).not.toContain("TO_DATE");
    expect(statement).not.toContain("TO_TIMESTAMP");
    expect(statement.match(/\('\d{4}-\d{2}-\d{2}', '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'\)/g)).toHaveLength(10);
  });
});
