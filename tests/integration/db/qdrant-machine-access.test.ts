/**
 * QE17 and VF3 end to end: what `inspect_schema` and the agent's grounding capture read from a real QdrantProvider
 * over a collection whose payload values, sampled payload keys, collection `metadata` and strict-mode values each
 * carry a marker. Both surfaces carry the collection, its vectors and its payload-index fields, and no marker.
 * The human view, `describeObject`, still lists the sampled key, marked `provenance: "sampled"`, so the test holds
 * the marker test of the machine surfaces against a provider that really sampled it.
 *
 * The provider is connected over a client whose answers this file writes from the seeded `docs` description, with
 * the markers added; nothing here calls a server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { captureContextSnapshot, packContextForTask } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { QdrantAnswer, QdrantRequest } from "@/lib/db/providers/vector/qdrant/client";
import { QDRANT_DEFAULT_PORT } from "@/lib/db/providers/vector/qdrant/connection-options";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState } from "../../helpers/mcp-fixtures";
import { recordedAnswer, resultOf, vectorCapture } from "../../helpers/qdrant-surface-fixtures";

pinMcpTestEnvironment();

const COLLECTION = "marked";
const VALUE_MARKER = "payload_value_marker_51c2";
const SAMPLED_KEY = "sampled_payload_key_marker_9e04";
const METADATA_MARKER = "collection_metadata_marker_6b7d";
/** A strict-mode value no other number in the description holds. */
const STRICT_MARKER = 734_291;
const MARKERS = [VALUE_MARKER, SAMPLED_KEY, METADATA_MARKER, String(STRICT_MARKER)];

const json = (value: unknown): QdrantAnswer => ({
  status: 200,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify({ result: value, status: "ok", time: 0.001 }),
});

/** The seeded `docs` description with a marker in its metadata and its strict-mode configuration. */
function markedDescription(): unknown {
  const described = resultOf(vectorCapture("describe-docs")) as { config: Record<string, unknown> };
  return {
    ...described,
    config: {
      ...described.config,
      metadata: { owner: METADATA_MARKER },
      strict_mode_config: { enabled: true, max_query_limit: STRICT_MARKER },
    },
  };
}

/** Every point the sample reads holds the sampled key and a marked value under an indexed key. */
const markedPoints = Array.from({ length: 3 }, (_, index) => ({
  id: index + 1,
  payload: { category: VALUE_MARKER, [SAMPLED_KEY]: VALUE_MARKER },
}));

function answer(request: QdrantRequest): QdrantAnswer {
  switch (request.op) {
    case "get_collections":
      return json({ collections: [{ name: COLLECTION }] });
    case "get_collection":
      return json(markedDescription());
    case "scroll_points":
      return json({ points: markedPoints, next_page_offset: null });
    case "count_points":
      return json({ count: markedPoints.length });
    default:
      return recordedAnswer(request);
  }
}

const CONNECTION: DatabaseConnection = {
  id: "seed:qdrant-marked",
  name: "Qdrant",
  type: "qdrant",
  host: "127.0.0.1",
  port: QDRANT_DEFAULT_PORT,
  seedId: "qdrant-marked",
  createdAt: new Date(0),
};

async function connected(): Promise<QdrantProvider> {
  const provider = new QdrantProvider(CONNECTION, {}, {}, () => ({
    send: async (request) => answer(request),
    close() {},
  }));
  await provider.connect();
  return provider;
}

let opened: QdrantProvider | undefined;

afterEach(async () => {
  await opened?.disconnect();
  opened = undefined;
  await resetMcpTestState();
});

function expectNoMarker(text: string): void {
  for (const marker of MARKERS) expect(text).not.toContain(marker);
}

describe("QE17: the machine surfaces carry the schema and no marker", () => {
  test("the provider did sample the marked key: the human view lists it, marked sampled", async () => {
    opened = await connected();
    const detail = await opened.describeObject([COLLECTION], "collection");
    expect(detail.columns.find((column) => column.name === SAMPLED_KEY)?.provenance).toBe("sampled");
  });

  test("inspect_schema answers the collection, its vectors and its payload indexes, and no marker", async () => {
    opened = await connected();
    const provider = opened;
    const context = {
      caller: { username: "alice", role: "admin" as const },
      resolve: async () => CONNECTION,
      acquire: async () => provider,
    } as unknown as McpConnectionContext;
    const result = await inspectSchema(InspectSchemaInputSchema.parse({ connection_id: CONNECTION.id }), {
      context,
      signal: new AbortController().signal,
    });
    expect(result.isError ?? false).toBe(false);
    const page = result.structuredContent as {
      tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
    };
    expect(page.tables.map((table) => table.name)).toEqual([COLLECTION]);
    const columns = page.tables[0].columns.map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["id", "vector.text", "vector.keywords", "category"]));
    expectNoMarker(JSON.stringify(result));
  });

  test("the agent's grounding capture and the context a model is handed hold no marker", async () => {
    opened = await connected();
    const provider = opened;
    const frozenClock = () => 1_000;
    const context = {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode: "agent",
      workflowType: "investigation",
      actor: { sessionId: "session-1", role: "user" },
      connection: CONNECTION,
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope("conn-1"),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(
        AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2,
        frozenClock,
      ),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => provider,
      clock: frozenClock,
    } as unknown as AgentToolContext;
    const capture = await captureContextSnapshot(context);
    if (capture.kind !== "captured") throw new Error(`expected a capture, got ${capture.kind}`);
    const object = capture.snapshot.objects.find((entry) => entry.name.endsWith(COLLECTION));
    expect(object?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["id", "vector.text", "category"]),
    );
    expectNoMarker(JSON.stringify(capture.snapshot));
    expectNoMarker(packContextForTask(capture.snapshot, COLLECTION));
  });
});
