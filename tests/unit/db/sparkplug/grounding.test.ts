/**
 * What a run is told about a Sparkplug connection when it grounds: nothing listed, on a clean "no inventory" answer
 * rather than a refused schema read. The capabilities are built the way the agent runtime builds a run's declarations,
 * and the provider the walk acquires is an agent-mode handle, so this is the drive path and not a hand-built handle.
 */
import { describe, expect, test } from "bun:test";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { languageServerPack } from "@/lib/agent/languages/server";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { type AgentToolContext, readObjectInventoryForGrounding } from "@/lib/agent/tools";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { ProviderCapabilities, QueryResult } from "@/lib/db/types";
import { connection, scriptedProvider } from "./fake-plant";

/** The harness the other grounding suites build, with the run's declarations passed in and acquisitions counted. */
function agentContext(capabilities: ProviderCapabilities): { context: AgentToolContext; acquired: string[] } {
  const clock = () => 1_000;
  const acquired: string[] = [];
  const { provider } = scriptedProvider([]);
  const context: AgentToolContext = {
    runId: "run-sparkplug",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection: connection(),
    capabilities,
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection().id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async (_connection, profile) => {
      acquired.push(profile);
      // Connected as the profiled seam hands a handle over: the agent-mode connect is a handshake only.
      await provider.connect();
      return provider;
    },
    clock,
  };
  return { context, acquired };
}

/** The run's declarations as `src/lib/agent/runtime.ts` builds them. */
async function runDeclarations(): Promise<ProviderCapabilities> {
  return (await createDatabaseProvider(connection(), {}, executionContextFor("agent-operations"))).getCapabilities();
}

describe("grounding a Sparkplug run", () => {
  test("the run's declarations name no level and no kind, so the walk acquires nothing and sends no schema read", async () => {
    const declared = await runDeclarations();
    expect(declared.containerLevels).toEqual([]);
    expect(declared.objectKinds).toEqual([]);

    const { context, acquired } = agentContext(declared);
    expect(await readObjectInventoryForGrounding(context)).toEqual({ kind: "unsupported" });
    expect(acquired).toEqual([]);
  });

  test("the capture is the clean no-inventory answer, and the language's ungrounded note says why and how to read", async () => {
    const { context, acquired } = agentContext(await runDeclarations());

    const capture = await captureContextSnapshot(context);

    expect(acquired).toEqual([]);
    expect(capture.kind).toBe("unavailable");
    if (capture.kind !== "unavailable") return;
    // Never the withheld sentence fenced as a failure of the database.
    expect(capture.modelText).not.toContain("database error");
    expect(capture.detail).toContain("declares no object kinds");
    const ungrounded = languageServerPack("sparkplugread").grounding.ungrounded;
    const note = ungrounded?.(capture.detail, { singular: "object", plural: "objects" }) ?? "";
    expect(note).toContain("No group, edge node or device is listed for the run");
    expect(note).toContain('{"read": "group", "group": "<group>"}');
  });

  test("why the runtime builds them that way: an editor's declarations walk a tree the agent-mode handle refuses", async () => {
    const { context, acquired } = agentContext((await createDatabaseProvider(connection())).getCapabilities());

    const read = await readObjectInventoryForGrounding(context);

    expect(acquired).toHaveLength(1);
    expect(read.kind).toBe("unavailable");
    if (read.kind !== "unavailable") return;
    expect(read.modelText).toContain("database error");
  });
});
