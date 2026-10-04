/**
 * What plan mode is told about an Oxia connection (SB2-10, SB2-12 D5): the object surface's inventory, which is the
 * shard rows and nothing else. No key name, no value and no leader address reaches the capture, and the capture reads
 * the shard map alone.
 */
import { describe, expect, test } from "bun:test";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import type { QueryResult } from "@/lib/db/types";
import { createFakeOxiaClient } from "../../../helpers/oxia-fake-client";
import { oxiaConnection } from "../../../helpers/oxia-connection";

const SECRET_KEY = "/admin/policies/tenant-secret-marker";
const SECRET_VALUE = "value-secret-marker";
const CONNECTION = oxiaConnection({ id: "oxia-grounding" });

/** The context-snapshot suite's harness with the provider behind it, as the Milvus machine-surfaces test builds it. */
function agentContext(provider: OxiaProvider): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: "run-oxia",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
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

describe("plan-mode grounding on Oxia", () => {
  test("the inventory holds the three shard rows, and no key, value or leader address", async () => {
    const fake = createFakeOxiaClient({
      order: "hierarchical",
      records: [{ key: SECRET_KEY, value: new TextEncoder().encode(SECRET_VALUE) }],
    });
    const provider = new OxiaProvider(CONNECTION, {}, {}, () => fake);
    await provider.connect();

    const capture = await captureContextSnapshot(agentContext(provider));

    expect(capture.kind).toBe("captured");
    if (capture.kind !== "captured") return;
    expect(capture.snapshot.objects.map((object) => object.kind)).toEqual(["shard", "shard", "shard"]);
    const text = JSON.stringify(capture);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("tenant-secret-marker");
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain("localhost:6648");
  });

  test("the capture reads the shard map alone: no key, no value, no order probe", async () => {
    const fake = createFakeOxiaClient({ order: "hierarchical", records: [{ key: SECRET_KEY }] });
    const provider = new OxiaProvider(CONNECTION, {}, {}, () => fake);
    await provider.connect();

    await captureContextSnapshot(agentContext(provider));

    expect(new Set(fake.calls.map((call) => call.rpc))).toEqual(new Set(["GetShardAssignments"]));
  });
});
