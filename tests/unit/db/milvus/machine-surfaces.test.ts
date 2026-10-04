/**
 * What a model or an MCP client is handed about a Milvus connection: names and types only. The agent's grounding and
 * `inspect_schema` are captured over a catalog whose function parameters and default values carry markers, and neither
 * capture holds a marker, a row or a vector; both read through the object surface alone and load nothing; and the
 * provider has no read-only statement path, so agent execution and the MCP read tool refuse the type.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import type { DatabaseConnection, QueryResult } from "@/lib/db/types";
import { McpConnectionContext } from "@/lib/mcp/context";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import type { ManagedConnection } from "@/lib/seed/types";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../../helpers/mcp-fixtures";
import {
  createFakeMilvusClient,
  DEFAULT_MARKER,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  type FakeCatalog,
  FTS,
  FTS_INDEX,
  FUNCTION_MARKER,
} from "../../../helpers/milvus-catalog-client";

pinMcpTestEnvironment();

const CONNECTION: DatabaseConnection = {
  id: "milvus-machine",
  name: "milvus machine",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

const CATALOG: FakeCatalog = {
  databases: {
    default: [
      { describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000" },
      { describe: FTS, indexes: [FTS_INDEX], rowCount: "3" },
    ],
  },
};

async function connected() {
  const client = createFakeMilvusClient(CATALOG);
  const provider = new MilvusProvider(CONNECTION, {}, { readOnly: true }, async () => client);
  await provider.connect();
  client.calls.length = 0;
  return { provider, client };
}

/** What the agent's capture is handed: the context-snapshot suite's harness with the provider behind it. */
function agentContext(provider: MilvusProvider): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: "run-milvus",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection: CONNECTION,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(CONNECTION.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
}

const READS_OF_THE_OBJECT_SURFACE = new Set([
  "listDatabases",
  "showCollections",
  "batchDescribeCollection",
  "describeCollection",
  "describeIndex",
]);

afterEach(async () => {
  await resetMcpTestState();
});

describe("agent grounding", () => {
  test("names the collections and their fields, and holds no default value and no function parameter", async () => {
    const { provider, client } = await connected();
    const capture = await captureContextSnapshot(agentContext(provider));
    expect(capture.kind).toBe("captured");
    const text = JSON.stringify(capture);
    expect(text).toContain("docs_int64");
    expect(text).toContain("text_sparse");
    expect(text).not.toContain(FUNCTION_MARKER);
    expect(text).not.toContain(DEFAULT_MARKER);
    for (const method of client.calls.map((call) => call.method))
      expect(READS_OF_THE_OBJECT_SURFACE.has(method)).toBe(true);
  });

  test("grounds through the bulk describe, with no index read, no row read and no load", async () => {
    const { provider, client } = await connected();
    await captureContextSnapshot(agentContext(provider));
    const methods = client.calls.map((call) => call.method);
    expect(methods).toContain("batchDescribeCollection");
    for (const never of [
      "describeIndex",
      "query",
      "search",
      "hybridSearch",
      "loadCollection",
      "getMetricsSystemInfo",
    ]) {
      expect(methods).not.toContain(never);
    }
  });
});

describe("inspect_schema", () => {
  test("answers names and types, a null default for every column, and holds no marker", async () => {
    const { provider, client } = await connected();
    const context = new McpConnectionContext({ username: "alice", role: "admin" });
    const managed: ManagedConnection = {
      ...CONNECTION,
      managed: true,
      roles: ["admin"],
      seedId: "milvus-machine",
      mcp: true,
    };
    spyOn(context, "resolve").mockResolvedValue(managed);
    const acquire = spyOn(context, "acquire").mockResolvedValue(provider);
    const result = await inspectSchema(
      InspectSchemaInputSchema.parse({
        connection_id: "seed:milvus-machine",
        include_columns: true,
        include_indexes: true,
      }),
      { context, signal: new AbortController().signal },
    );
    expect(result.isError).not.toBe(true);
    expect(acquire).toHaveBeenCalledWith(managed, "agent-operations");
    const text = JSON.stringify(result);
    expect(text).toContain("docs_int64");
    expect(text).toContain("fts");
    expect(text).not.toContain(FUNCTION_MARKER);
    expect(text).not.toContain(DEFAULT_MARKER);
    const tables = (result.structuredContent as { tables: Array<{ columns: Array<{ default_value: unknown }> }> })
      .tables;
    expect(tables.flatMap((table) => table.columns).every((column) => column.default_value === null)).toBe(true);
    for (const method of client.calls.map((call) => call.method))
      expect(READS_OF_THE_OBJECT_SURFACE.has(method)).toBe(true);
  });
});

describe("no statement of the model's runs against Milvus", () => {
  test("the provider has no read-only statement path, and the type is not an agent execution engine", async () => {
    const { provider } = await connected();
    expect("queryReadOnly" in provider).toBe(false);
    const engines: readonly string[] = AGENT_EXECUTION_ENGINES;
    expect(engines).not.toContain("milvus");
    expect(provider.getCapabilities().supportsExplain).toBe(false);
  });
});
