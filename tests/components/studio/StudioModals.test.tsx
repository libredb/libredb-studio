import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { StudioModals } from "@/components/studio/StudioModals";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";
import type { DetailedObject } from "@/lib/db/detailed-object";
import { pathKey } from "@/lib/db/object-path";
import type { ProviderCapabilities } from "@/lib/db/types";
import { mockPostgresConnection } from "../../fixtures/connections";
import { mockSchema } from "../../fixtures/schemas";

// =============================================================================
// StudioModals hands the profiler the masking its shell hands the grid (#1421)
// =============================================================================

const profile = {
  tableName: "users",
  totalRows: 2,
  columns: [
    {
      name: "email",
      type: "varchar(255)",
      totalRows: 2,
      nullCount: 0,
      nullPercent: 0,
      distinctCount: 2,
      minValue: "alice@example.com",
      maxValue: "zara@example.com",
      sampleValues: ["alice@example.com"],
    },
  ],
};

function renderModals(
  profilerMasking: React.ComponentProps<typeof StudioModals>["profilerMasking"],
  overrides: Partial<React.ComponentProps<typeof StudioModals>> = {},
) {
  const noop = mock(() => {});
  return render(
    <StudioModals
      activeConnection={mockPostgresConnection}
      schema={mockSchema}
      schemaContext=""
      databaseType="postgres"
      showSaveQuery={false}
      saveQueryModalOpen={false}
      onCloseSaveQuery={noop}
      onSaveQuery={noop}
      defaultQuery=""
      showImport={false}
      importModalOpen={false}
      onCloseImport={noop}
      onImport={noop}
      safetyCheckQuery={null}
      onCloseSafety={noop}
      onProceedSafety={noop}
      showCodeGenerator
      profilerPath={["public", "users"]}
      onCloseProfiler={noop}
      profilerMasking={profilerMasking}
      codeGenPath={null}
      onCloseCodeGen={noop}
      showTestDataGenerator={false}
      testDataPath={null}
      onCloseTestData={noop}
      onExecuteTestData={noop}
      unlimitedWarningOpen={false}
      onUnlimitedWarningChange={noop}
      onLoadAll={noop}
      {...overrides}
    />,
  );
}

describe("StudioModals: the profiler's masking", () => {
  beforeEach(() => {
    mockGlobalFetch({
      "/api/db/profile": { ok: true, json: profile },
      "/api/ai/describe-schema": { ok: false, status: 500, json: { error: "AI not configured" } },
    });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("masking in force reaches the profiler, which masks the column", async () => {
    const { container } = renderModals({ config: DEFAULT_MASKING_CONFIG, enabled: true, role: "user" });
    await waitFor(() => {
      expect(container.textContent).toContain("Column Profiles");
    });
    expect(container.textContent).not.toContain("alice@example.com");
  });

  test("masking switched off reaches the profiler too, which then shows the value", async () => {
    const { container } = renderModals({ config: DEFAULT_MASKING_CONFIG, enabled: false, role: "admin" });
    await waitFor(() => {
      expect(container.textContent).toContain("Column Profiles");
    });
    expect(container.textContent).toContain("alice@example.com");
  });
});

// =============================================================================
// StudioModals hands its dialogs the connection's type, which picks an SQL engine's quoting (FND-1)
// =============================================================================

describe("StudioModals: the connection's type reaches the Test Data and import dialogs", () => {
  const orderItems = {
    name: "Order Items",
    kind: "table",
    path: ["shop", "Order Items"],
    columns: [{ name: "order date", type: "VARCHAR(50)", nullable: false, isPrimary: false }],
    indexes: [],
  } as unknown as DetailedObject;
  // MySQL's own declaration names no identifierQuoting: its backticks are its SQL engine row, read by the type alone.
  const mysqlShaped = {
    queryLanguage: "sql",
    defaultPort: 3306,
    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true }],
  } as unknown as ProviderCapabilities;
  const mysql = {
    activeConnection: { ...mockPostgresConnection, type: "mysql" as const },
    databaseType: "mysql" as const,
    schema: [orderItems],
    capabilities: mysqlShaped,
  };

  afterEach(() => {
    cleanup();
  });

  test("the Test Data statement for a MySQL connection is quoted with backticks", () => {
    const { baseElement } = renderModals(
      { config: DEFAULT_MASKING_CONFIG, enabled: false, role: "admin" },
      {
        ...mysql,
        showCodeGenerator: false,
        profilerPath: null,
        showTestDataGenerator: true,
        testDataPath: ["shop", "Order Items"],
      },
    );
    expect(baseElement.textContent ?? "").toContain("INSERT INTO shop.`Order Items` (`order date`)");
  });

  test("the import statement for a MySQL connection is quoted with backticks", () => {
    const { baseElement } = renderModals(
      { config: DEFAULT_MASKING_CONFIG, enabled: false, role: "admin" },
      { ...mysql, showCodeGenerator: false, profilerPath: null, showImport: true, importModalOpen: true },
    );
    const content = "order date\n2026-01-01";
    const origFileReader = globalThis.FileReader;
    // The reader answers at once, so the upload is parsed inside the act below.
    globalThis.FileReader = class {
      onload = null as ((e: { target: { result: string } }) => void) | null;
      readAsText() {
        this.onload?.({ target: { result: content } });
      }
    } as unknown as typeof FileReader;
    try {
      const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new File([content], "data.csv", { type: "text/csv" })] });
      act(() => {
        fireEvent.change(input);
      });
    } finally {
      globalThis.FileReader = origFileReader;
    }
    act(() => fireEvent.click(within(baseElement).getByText("Configure Import")));
    const select = within(baseElement).getByLabelText("Select Table") as HTMLSelectElement;
    act(() => fireEvent.change(select, { target: { value: pathKey(["shop", "Order Items"]) } }));
    act(() => fireEvent.click(within(baseElement).getByText("Review SQL")));
    // Only the address is quoted here: an existing table's columns stay as the mapping spells them.
    expect(baseElement.querySelector("pre")?.textContent ?? "").toContain("INSERT INTO shop.`Order Items` (");
  });
});

// =============================================================================
// StudioModals hands the safety dialog the typed confirmation its shell already read (FND-5 slice 6c)
// =============================================================================

describe("StudioModals: the safety check's typed confirmation", () => {
  afterEach(() => {
    cleanup();
  });

  test("hands the safety check's typed confirmation to the dialog, and its typed value to onProceedSafety", () => {
    const name = crypto.randomUUID();
    const onProceedSafety = mock((_typed?: string) => {});
    const { baseElement } = renderModals(
      { config: DEFAULT_MASKING_CONFIG, enabled: false, role: "admin" },
      {
        databaseType: "etcd",
        connectionName: name,
        showCodeGenerator: false,
        profilerPath: null,
        safetyCheckQuery: "del /a /b",
        safetyCheckTypedConfirmation: { type: "connection-name", expected: name, targets: ["/a"] },
        onProceedSafety,
      },
    );
    const dialog = within(baseElement).getByRole("alertdialog");
    expect(dialog.textContent).toContain("/a");
    act(() => fireEvent.change(within(dialog).getByLabelText(`Type ${name} to confirm`), { target: { value: name } }));
    act(() => fireEvent.click(within(dialog).getByRole("button", { name: "Execute Query" })));
    expect(onProceedSafety.mock.calls).toEqual([[name]]);
  });
});
