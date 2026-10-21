import "../../../setup-dom";
import { mockToastDefault, mockToastError, mockToastLoading, mockToastSuccess } from "../../../helpers/mock-sonner";
import "../../../helpers/mock-navigation";

import { mock } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConsentCard } from "@/components/agent/ConsentCard";
import { type ExplainPlanResult, VisualExplain } from "@/components/VisualExplain";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { useQueryExecution } from "@/hooks/use-query-execution";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseConnection, DatabaseType, QueryTab } from "@/lib/types";

import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";

/**
 * Today's execution UI per engine, through the real hook and the real components: the keyword the rolled-back
 * transaction notice names (as `tests/hooks/use-query-execution.test.ts` drives it), the hand-over consent chips and
 * SQLite deadline sentence (as `tests/components/agent/ConsentCard.test.tsx` renders it), and the engine hint the AI
 * explain request carries (as `tests/components/VisualExplain.test.tsx` sends it). Every engine id, then the inputs
 * that are no engine: no connection, the empty string, two prototype keys and an unknown id.
 */
export const GOLDEN_KEYS: readonly string[] = Object.freeze([
  ...EXTERNAL_DATABASE_TYPES,
  "libredb",
  "no-connection",
  "empty-string",
  "constructor",
  "__proto__",
  "not-an-engine",
]);

/** `undefined` is no connection at all; every other key is the engine string the code is handed. */
function engineOf(key: string): string | undefined {
  if (key === "no-connection") return undefined;
  if (key === "empty-string") return "";
  return key;
}

const mockConnection: DatabaseConnection = {
  id: "qe-pg-1",
  name: "Test PostgreSQL",
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "testuser",
  password: "testpass",
  database: "testdb",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  environment: "development",
};

/** The same postgres-shaped metadata for every key, so only the connection type varies. */
const mockMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: "sql" as const,
    supportsExplain: true,
    explainFormat: "postgres-json" as const,
    supportsExternalQueryLimiting: true,
    supportsInlineRowEdit: true,
    supportsMaintenance: true,
    maintenanceOperations: ["vacuum", "analyze"],
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: "^(CREATE|DROP|ALTER)\\b",
  },
  labels: {
    entityName: "Table",
    entityNamePlural: "Tables",
    rowName: "Row",
    rowNamePlural: "Rows",
    selectAction: "SELECT * FROM",
    generateAction: "Generate SELECT",
    analyzeAction: "Analyze",
    vacuumAction: "Vacuum",
    searchPlaceholder: "Search tables...",
    analyzeGlobalLabel: "Analyze All",
    analyzeGlobalTitle: "Analyze All Tables",
    analyzeGlobalDesc: "Analyze all tables in the database",
    vacuumGlobalLabel: "Vacuum All",
    vacuumGlobalTitle: "Vacuum All Tables",
    vacuumGlobalDesc: "Vacuum all tables in the database",
  },
};

const mockQueryResult = {
  rows: [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ],
  fields: ["id", "name"],
  rowCount: 2,
  executionTime: 15,
  pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
};

function createDefaultParams(activeConnection: DatabaseConnection | null) {
  const tab: QueryTab = {
    id: "tab-1",
    name: "Query 1",
    query: "SELECT * FROM users",
    result: null,
    isExecuting: false,
    type: "sql",
  };
  return {
    activeConnection,
    metadata: mockMetadata,
    tabs: [tab],
    activeTabId: "tab-1",
    currentTab: tab,
    setTabs: mock((fn: unknown) => {
      if (typeof fn === "function") fn([tab]);
    }),
    transactionActive: false,
    playgroundMode: false,
    fetchSchema: mock(async () => {}),
    queryEditorRef: { current: null },
  };
}

function clearToasts(): void {
  mockToastSuccess.mockClear();
  mockToastError.mockClear();
  mockToastDefault.mockClear();
  mockToastLoading.mockClear();
}

async function commitLine(engine: string | undefined): Promise<string> {
  clearToasts();
  mockGlobalFetch({
    "/api/db/query": { ok: true, json: { ...mockQueryResult, openTransaction: "rolled-back" } },
  });
  const connection = engine === undefined ? null : { ...mockConnection, type: engine as DatabaseType };
  const { result, unmount } = renderHook(() => useQueryExecution(createDefaultParams(connection)));
  try {
    await act(async () => {
      await result.current.executeQuery("BEGIN");
    });
    const last = mockToastSuccess.mock.calls.at(-1) as unknown[] | undefined;
    if (last === undefined) return "none";
    return JSON.stringify((last[1] as { description?: string }).description);
  } finally {
    unmount();
    restoreGlobalFetch();
    clearToasts();
  }
}

function consentLine(engine: string | undefined, autoExecute: boolean): string {
  render(
    <ConsentCard
      workflowType="data-analysis"
      workflowLabel="Analyze"
      connectionName="Sales"
      engine={engine === undefined ? null : (engine as DatabaseType)}
      language="sql"
      autoExecute={autoExecute}
      onAutoExecuteChange={() => {}}
      onOpen={() => {}}
      onCancel={() => {}}
      regionRef={{ current: null }}
    />,
  );
  try {
    const sentenceNode = screen.queryByTestId("agent-auto-execute-sqlite");
    const sentence = sentenceNode === null ? null : sentenceNode.textContent;
    if (!autoExecute) return JSON.stringify({ sentence });
    const chips = Array.from(screen.getByTestId("agent-consent-bounds").children).map((span) => span.textContent);
    return JSON.stringify({ chips, sentence });
  } finally {
    cleanup();
  }
}

const samplePlan: ExplainPlanResult[] = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "users",
      "Actual Rows": 15000,
      "Plan Rows": 100,
      "Actual Total Time": 42.5,
      "Total Cost": 120,
      "Shared Hit Blocks": 80,
      "Shared Read Blocks": 5,
      Filter: "status = active",
      Plans: [
        {
          "Node Type": "Index Scan",
          "Relation Name": "orders",
          "Actual Rows": 200,
          "Plan Rows": 200,
          "Actual Total Time": 1.2,
          "Total Cost": 10,
          "Index Name": "idx_orders_user_id",
        },
      ],
    },
    "Execution Time": 42.5,
    "Planning Time": 0.8,
  },
];

function mockFetchStream(body: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return mock(() => Promise.resolve({ ok: true, body: stream, json: () => Promise.resolve({}) }));
}

async function explainLine(engine: string | undefined): Promise<string> {
  const originalFetch = globalThis.fetch;
  const fetchMock = mockFetchStream("## Analysis\nThis query performs a seq scan.");
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const user = userEvent.setup();
    render(<VisualExplain plan={samplePlan} query="SELECT * FROM users" databaseType={engine} />);
    fireEvent.click(screen.getByText("AI Explain"));
    await user.click(screen.getByText("Analyze with AI"));
    await waitFor(() => {
      if (fetchMock.mock.calls.length === 0) throw new Error("explain request not sent");
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    return JSON.stringify(JSON.parse(init.body as string).databaseType);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
}

export async function renderExecutionUiGolden(key: string): Promise<string> {
  const engine = engineOf(key);
  const lines = [
    `commit => ${await commitLine(engine)}`,
    `consent ticked => ${consentLine(engine, true)}`,
    `consent unticked => ${consentLine(engine, false)}`,
    `explain => ${await explainLine(engine)}`,
  ];
  return `${lines.join("\n")}\n`;
}
