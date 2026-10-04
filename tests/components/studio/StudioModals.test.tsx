import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { StudioModals } from "@/components/studio/StudioModals";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";
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

function renderModals(profilerMasking: React.ComponentProps<typeof StudioModals>["profilerMasking"]) {
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
