import { describe, expect, test } from "bun:test";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { type AgentToolContext, readObjectInventoryForGrounding } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { QueryError } from "@/lib/db/errors";
import type { Container, DatabaseConnection, DatabaseProvider, KindCount, QueryResult } from "@/lib/db/types";
import { createMockProvider } from "../../../helpers/mock-provider";

/**
 * Plan mode's grounding walk over a provider whose containers name the kinds they hold.
 *
 * A cluster's `Cluster` container holds the cluster-scoped kinds and a namespace the namespaced ones,
 * and the provider refuses the other pairs with a sentence. The walk asks each container only for its
 * own kinds, so one refused pair cannot end the whole capture; a provider whose containers name no
 * kinds is walked exactly as before.
 */

const CONNECTION: DatabaseConnection = {
  id: "conn-kinds",
  name: "Kinds",
  type: "postgres",
  host: "localhost",
  database: "app",
  createdAt: new Date(0),
};

const POD = { id: "pods", role: "config", label: "Pod", labelPlural: "Pods" } as const;
const NODE = { id: "nodes", role: "config", label: "Node", labelPlural: "Nodes" } as const;

/** The provider's listings, and every pair it was asked to list. */
function clusterProvider(containers: Container[]): { provider: DatabaseProvider; listed: string[] } {
  const listed: string[] = [];
  const provider = createMockProvider({
    capabilities: {
      containerLevels: [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }],
      objectKinds: [POD, NODE],
    },
  });
  provider.listContainers = async () => containers;
  provider.countObjects = async (container: readonly string[]): Promise<Record<string, KindCount>> =>
    container[0] === "Cluster" ? { nodes: { count: 1 } } : { pods: { count: 1 } };
  provider.listObjects = async (container: readonly string[], kind: string) => {
    listed.push(`${container[0]}/${kind}`);
    const holds = container[0] === "Cluster" ? kind === "nodes" : kind === "pods";
    if (!holds) throw new QueryError(`the container ${container[0]} holds no ${kind}`, "postgres");
    return [{ path: [...container, `${kind}-one`], name: `${kind}-one`, kind }];
  };
  return { provider, listed };
}

/** The context-snapshot suite's harness, with the provider behind it. */
function agentContext(provider: DatabaseProvider): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: "run-kinds",
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

describe("the grounding walk reads each container's own kinds", () => {
  test("a container that names its kinds is asked for those alone, and the capture completes", async () => {
    const { provider, listed } = clusterProvider([
      { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] },
      { path: ["shop"], name: "shop", level: 0, kinds: ["pods"], isSessionDefault: true },
    ]);

    const read = await readObjectInventoryForGrounding(agentContext(provider));

    if (read.kind !== "completed") throw new Error(`the inventory read did not complete: ${read.kind}`);
    expect(listed).toEqual(["Cluster/nodes", "shop/pods"]);
    expect(read.inventory.objects.map((object) => object.path)).toEqual([
      ["Cluster", "nodes-one"],
      ["shop", "pods-one"],
    ]);
    expect(read.defaultContainer).toEqual(["shop"]);
    // The kinds of the inventory are still every enumerable kind: what a container holds narrows the
    // listings, never the vocabulary plan mode is told.
    expect(read.inventory.kinds?.map((kind) => kind.id)).toEqual(["pods", "nodes"]);
  });

  test("containers that name no kinds are walked for every enumerable kind, as before", async () => {
    const { provider, listed } = clusterProvider([
      { path: ["Cluster"], name: "Cluster", level: 0 },
      { path: ["shop"], name: "shop", level: 0 },
    ]);
    provider.countObjects = async () => ({});
    provider.listObjects = async (container: readonly string[], kind: string) => {
      listed.push(`${container[0]}/${kind}`);
      return [];
    };

    const read = await readObjectInventoryForGrounding(agentContext(provider));

    expect(read.kind).toBe("completed");
    expect(listed).toEqual(["Cluster/pods", "Cluster/nodes", "shop/pods", "shop/nodes"]);
  });
});
