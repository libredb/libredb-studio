/**
 * The agent's grounding walk over a provider's object surface: the kinds whose names it withholds, the containers
 * a scoped walk leaves out, and a listing its provider capped, each as the walk records it and as both packers
 * tell a run.
 *
 * The provider is a stub answering the four object methods, so each rule is pinned apart from any engine.
 */
import { describe, expect, mock, test } from "bun:test";
import { captureContextSnapshot, packContextForTask, packOperationsInventory } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { AgentContextSnapshot } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type {
  Container,
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";

const frozenClock = () => 1_000;

const BASE: ProviderCapabilities = {
  queryLanguage: "json",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: null,
  schemaRefreshPattern: "manual",
  containerLevels: [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }],
};

const POD: ObjectKindSpec = { id: "pods", role: "config", label: "Pod", labelPlural: "Pods" };
const SECRET: ObjectKindSpec = {
  id: "secrets",
  role: "config",
  label: "Secret",
  labelPlural: "Secrets",
  machineNames: "withheld",
};

/** A planted Secret name: it must reach no part of the capture and no packing. */
const SECRET_NAME = "secret/db-password-marker";

interface Stub {
  readonly kinds?: readonly ObjectKindSpec[];
  /** Further capability declarations, such as a walk scope. */
  readonly extra?: Partial<ProviderCapabilities>;
  readonly containers?: readonly Container[];
  readonly counts?: (container: readonly string[]) => Record<string, KindCount>;
  readonly objects?: (container: readonly string[], kind: string) => readonly DatabaseObject[];
}

function stub(options: Stub = {}) {
  const listObjects = mock(
    async (container: readonly string[], kind: string) =>
      options.objects?.(container, kind) ?? [
        kind === "secrets"
          ? { path: [...container, SECRET_NAME], name: SECRET_NAME, kind }
          : { path: [...container, "pod/web"], name: "pod/web", kind },
      ],
  );
  const countObjects = mock(
    async (container: readonly string[]) =>
      options.counts?.(container) ?? { pods: { count: 1 }, secrets: { count: 2 } },
  );
  const listContainers = mock(
    async () =>
      options.containers ?? [
        { path: ["default"], name: "default", level: 0, isSessionDefault: true },
        { path: ["shop"], name: "shop", level: 0 },
      ],
  );
  const provider = {
    listObjects,
    countObjects,
    listContainers,
    describeObjects: mock(async () => ({ details: [] })),
  } as unknown as DatabaseProvider;
  const context: AgentToolContext = {
    runId: "run-1",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection: { id: "conn-1", name: "Cluster", type: "mongodb", createdAt: new Date(0) },
    capabilities: {
      ...BASE,
      objectKinds: options.kinds ?? [POD, SECRET],
      ...options.extra,
    },
    labels: TABLE_LABELS,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope("conn-1"),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, frozenClock),
    repairs: new AgentRepairLedger(),
    acquireProvider: mock(async () => provider),
    clock: frozenClock,
  };
  return { context, listObjects, countObjects, listContainers };
}

async function captured(
  options: Stub = {},
): Promise<{ snapshot: AgentContextSnapshot; harness: ReturnType<typeof stub> }> {
  const harness = stub(options);
  const capture = await captureContextSnapshot(harness.context);
  if (capture.kind !== "captured") throw new Error(`expected a capture, got ${capture.kind}`);
  return { snapshot: capture.snapshot, harness };
}

const packings = (snapshot: AgentContextSnapshot): readonly string[] => [
  packContextForTask(snapshot, "why do pods restart"),
  packOperationsInventory(snapshot),
];

describe("a kind whose names are withheld", () => {
  test("is counted and never listed, and its names reach neither the capture nor either packing", async () => {
    const { snapshot, harness } = await captured();

    expect(harness.listObjects.mock.calls.map((call) => call[1])).toEqual(["pods", "pods"]);
    expect(snapshot.kinds?.find((kind) => kind.id === "secrets")?.withheldCount).toBe(4);
    expect(snapshot.objects.every((object) => object.kind === "pods")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("db-password-marker");
    for (const packed of packings(snapshot)) {
      expect(packed).not.toContain("db-password-marker");
      expect(packed).toContain(
        "The names of the Secrets are withheld from this inventory: this server counted 4 of them in what it read, and none is listed below.",
      );
    }
  });

  test("a refused count carries the provider's sentence and still lists nothing", async () => {
    const refusal = "Listing Secrets in default is forbidden for this identity";
    const { snapshot, harness } = await captured({
      containers: [{ path: ["default"], name: "default", level: 0, isSessionDefault: true }],
      counts: () => ({ pods: { count: 1 }, secrets: { unavailable: refusal } }),
    });

    expect(harness.listObjects.mock.calls.map((call) => call[1])).toEqual(["pods"]);
    const secrets = snapshot.kinds?.find((kind) => kind.id === "secrets");
    expect(secrets?.unavailable).toBe(refusal);
    expect(secrets?.withheldCount).toBeUndefined();
  });

  test("a sampled count is said as a floor", async () => {
    const { snapshot } = await captured({
      containers: [{ path: ["default"], name: "default", level: 0, isSessionDefault: true }],
      counts: () => ({ pods: { count: 1 }, secrets: { count: 7, sampledFrom: "one bounded page" } }),
    });

    for (const packed of packings(snapshot)) expect(packed).toContain("this server counted at least 7 of them");
  });

  test("a kind counted as none everywhere carries no count and no note", async () => {
    const { snapshot } = await captured({ counts: () => ({ pods: { count: 1 }, secrets: { count: 0 } }) });

    expect(snapshot.kinds?.find((kind) => kind.id === "secrets")?.withheldCount).toBeUndefined();
    for (const packed of packings(snapshot)) expect(packed).not.toContain("withheld");
  });

  test("a kind with no count is never listed, and the run is told its names are withheld and were not counted", async () => {
    const { snapshot, harness } = await captured({ counts: () => ({ pods: { count: 1 } }) });

    expect(harness.listObjects.mock.calls.map((call) => call[1])).toEqual(["pods", "pods"]);
    expect(JSON.stringify(snapshot)).not.toContain("db-password-marker");
    const secrets = snapshot.kinds?.find((kind) => kind.id === "secrets");
    expect(secrets?.withheldUncounted).toBe(true);
    expect(secrets?.withheldCount).toBeUndefined();
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        "The names of the Secrets are withheld from this inventory and were not counted: none is listed below.",
      );
    }
  });

  test("a count in one container and none in another is said as a floor", async () => {
    const { snapshot } = await captured({
      counts: (container): Record<string, KindCount> =>
        container[0] === "default" ? { pods: { count: 1 }, secrets: { count: 3 } } : { pods: { count: 1 } },
    });

    for (const packed of packings(snapshot)) expect(packed).toContain("this server counted at least 3 of them");
  });

  test("a count in one container and a refusal in another is said as a floor beside the provider's sentence", async () => {
    const refusal = "Listing Secrets in shop is forbidden for this identity";
    const { snapshot } = await captured({
      counts: (container): Record<string, KindCount> =>
        container[0] === "default"
          ? { pods: { count: 1 }, secrets: { count: 3 } }
          : { pods: { count: 1 }, secrets: { unavailable: refusal } },
    });

    for (const packed of packings(snapshot)) {
      expect(packed).toContain(`The Secrets could not be read: ${refusal}.`);
      expect(packed).toContain("this server counted at least 3 of them");
    }
  });
});

describe("a listing its provider capped", () => {
  test("a sampled count over 1,000 listed objects is said as a floor in both packings, and the walk adds no bound of its own", async () => {
    const floor = "the first 1,000 objects of the folder";
    const { snapshot } = await captured({
      kinds: [POD],
      containers: [{ path: ["default"], name: "default", level: 0, isSessionDefault: true }],
      counts: () => ({ pods: { count: 1000, sampledFrom: floor } }),
      objects: (container, kind) =>
        Array.from({ length: 1000 }, (_unused, index) => ({
          path: [...container, `pod/web-${index}`],
          name: `pod/web-${index}`,
          kind,
        })),
    });

    expect(snapshot.objects).toHaveLength(1000);
    expect(snapshot.truncated).toBeUndefined();
    expect(snapshot.kinds?.[0]?.sampledFrom).toBe(floor);
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        `The Pods below are at least what is shown and never a total: they were counted from ${floor}.`,
      );
    }
  });
});

describe("a scoped walk", () => {
  const containers: readonly Container[] = [
    { path: ["Cluster"], name: "Cluster", level: 0 },
    { path: ["default"], name: "default", level: 0, isSessionDefault: true },
    { path: ["shop"], name: "shop", level: 0 },
    { path: ["billing"], name: "billing", level: 0 },
  ];

  test("reads the session-default container and the ones the provider names, and says how many it did not", async () => {
    const { snapshot, harness } = await captured({
      kinds: [POD],
      containers,
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    expect(harness.countObjects.mock.calls.map((call) => call[0])).toEqual([["Cluster"], ["default"]]);
    expect(snapshot.unreadContainers).toEqual({
      count: 2,
      label: "Namespace",
      labelPlural: "Namespaces",
      read: ["Cluster", "default"],
    });
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        'Not read: 2 other Namespaces. This inventory covers only the 2 Namespaces it read ("Cluster", "default"),',
      );
    }
  });

  test("a read that lists nothing still names the containers it read", async () => {
    const { snapshot } = await captured({
      containers: containers.slice(0, 3),
      counts: () => ({ pods: { count: 0 }, secrets: { count: 2 } }),
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    expect(snapshot.objects).toEqual([]);
    for (const packed of packings(snapshot)) {
      expect(packed).toContain(
        'Not read: 1 other Namespace. This inventory covers only the 2 Namespaces it read ("Cluster", "default"),',
      );
    }
  });

  test("one container read is named in the singular", async () => {
    const { snapshot } = await captured({
      kinds: [POD],
      containers: containers.slice(1, 3),
      extra: { agentWalkScope: { mode: "session-default" } },
    });

    for (const packed of packings(snapshot)) {
      expect(packed).toContain('This inventory covers only the 1 Namespace it read ("default"),');
    }
  });

  test("one container left out is named in the singular", async () => {
    const { snapshot } = await captured({
      kinds: [POD],
      containers: containers.slice(0, 3),
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    for (const packed of packings(snapshot)) expect(packed).toContain("Not read: 1 other Namespace.");
  });

  test("no scope reads every container and carries no note", async () => {
    const { snapshot, harness } = await captured({ kinds: [POD], containers });

    expect(harness.countObjects).toHaveBeenCalledTimes(4);
    expect(snapshot.unreadContainers).toBeUndefined();
    for (const packed of packings(snapshot)) expect(packed).not.toContain("Not read:");
  });

  test("a scope that keeps every container carries no note", async () => {
    const { snapshot } = await captured({
      kinds: [POD],
      containers: containers.slice(0, 2),
      extra: { agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] } },
    });

    expect(snapshot.unreadContainers).toBeUndefined();
  });
});
