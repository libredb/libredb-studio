/**
 * The result export menu's SQL formats, read per dialect (vector-family spec 3.10, R46 C4, BACKLOG U69).
 *
 * R46 C4 measured the Export menu of seven engines offering SQL INSERT and DDL; each keeps both here, under its
 * own language and dialect. Qdrant's record declines them, and so does a synthetic dialect record, which no shipped
 * engine has, so the rule is pinned apart from any engine: both the Export and the Copy items must leave them out. The registry is mocked for that one name only and the mock is
 * process-wide, so this file is separate from `BottomPanel.test.tsx`.
 */
import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DialectSpec } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

const SYNTHETIC_DIALECT = "synthetic-declines-sql";
const DECLINES_SQL_EXPORT: DialectSpec = {
  tabType: "kafka",
  offersColumnProfiling: false,
  offersCodeGeneration: false,
  offersCountQuery: false,
  offersSqlExport: false,
};

const realDialects = { ...(await import("@/lib/db/query-dialects")) };
mock.module("@/lib/db/query-dialects", () => ({
  ...realDialects,
  dialectSpec: (capabilities: ProviderCapabilities | undefined) =>
    (capabilities?.queryDialect as string | undefined) === SYNTHETIC_DIALECT
      ? DECLINES_SQL_EXPORT
      : realDialects.dialectSpec(capabilities),
}));

const { BottomPanel } = await import("@/components/studio/BottomPanel");

const ALL_ITEMS = [
  "Export as CSV",
  "Export as CSV (semicolon)",
  "Export as CSV (tab)",
  "Export as JSON",
  "Export as SQL INSERT",
  "Export as DDL (CREATE TABLE)",
  "Copy as CSV",
  "Copy as CSV (semicolon)",
  "Copy as CSV (tab)",
  "Copy as JSON",
  "Copy as SQL INSERT",
  "Copy as DDL (CREATE TABLE)",
];
const WITHOUT_SQL = ALL_ITEMS.filter((item) => !item.includes("SQL INSERT") && !item.includes("DDL"));

function capabilitiesOf(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return {
    queryLanguage: "json",
    supportsExplain: false,
    supportsExternalQueryLimiting: false,
    supportsCreateTable: false,
    supportsInlineRowEdit: false,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    schemaRefreshPattern: "",
    defaultPort: null,
    ...overrides,
  };
}

/** Opens the Export menu over a one-row result and lists its items, Export and Copy alike. */
async function exportMenuItems(capabilities: ProviderCapabilities | null): Promise<string[]> {
  const props = {
    mode: "results",
    onSetMode: mock(() => {}),
    result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 1 },
    explainPlan: undefined,
    explainQuery: "SELECT 1",
    resultQuery: undefined,
    runError: undefined,
    schema: [],
    schemaContext: "[]",
    activeConnection: null,
    metadata: capabilities === null ? null : { capabilities },
    historyKey: 0,
    savedKey: 0,
    maskingEnabled: false,
    onToggleMasking: undefined,
    userRole: "user",
    maskingConfig: {
      enabled: false,
      patterns: [],
      roleSettings: {
        admin: { canToggle: true, canReveal: true },
        user: { canToggle: false, canReveal: false },
      },
    },
    editingEnabled: false,
    pendingChanges: [],
    onCellChange: mock(() => {}),
    onApplyChanges: mock(() => {}),
    onDiscardChanges: mock(() => {}),
    onLoadQuery: mock(() => {}),
    onLoadMore: undefined,
    isLoadingMore: false,
    onExportResults: mock(() => {}),
    onCopyResults: mock(() => {}),
  };
  const { getByText } = render(<BottomPanel {...(props as unknown as React.ComponentProps<typeof BottomPanel>)} />);
  await userEvent.click(getByText("Export"));
  return within(document.body as HTMLElement)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

/** The seven engines R46 C4 probed, each by the language and dialect its provider declares. */
const PROBED: readonly (readonly [string, Partial<ProviderCapabilities>])[] = [
  ["postgres", { queryLanguage: "sql" }],
  ["mongodb", { queryLanguage: "json" }],
  ["redis", { queryLanguage: "json", queryDialect: "redis" }],
  ["libredb", { queryLanguage: "json", queryDialect: "libredb" }],
  ["kafka", { queryLanguage: "json", queryDialect: "kafka" }],
  ["etcd", { queryLanguage: "json", queryDialect: "etcd" }],
  ["prometheus", { queryLanguage: "promql" }],
];

afterEach(() => cleanup());

describe("the result export menu offers the SQL formats where the dialect says they apply", () => {
  for (const [engine, declared] of PROBED) {
    test(`${engine} keeps both SQL formats in the Export and the Copy items`, async () => {
      expect(await exportMenuItems(capabilitiesOf(declared))).toEqual(ALL_ITEMS);
    });
  }

  test("capabilities that have not arrived keep both, as the menu always did", async () => {
    expect(await exportMenuItems(null)).toEqual(ALL_ITEMS);
  });

  test("qdrant, whose record declines them, loses both from the Export and the Copy items (vector-family spec 3.10)", async () => {
    expect(await exportMenuItems(capabilitiesOf({ queryDialect: "qdrant" }))).toEqual(WITHOUT_SQL);
  });

  test("a dialect whose record declines them loses both, from the Export and the Copy items alike", async () => {
    const declared = capabilitiesOf({ queryDialect: SYNTHETIC_DIALECT as ProviderCapabilities["queryDialect"] });
    expect(await exportMenuItems(declared)).toEqual(WITHOUT_SQL);
  });
});
