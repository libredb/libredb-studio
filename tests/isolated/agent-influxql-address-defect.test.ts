/**
 * An InfluxQL measurement's address in an agent run's grounding capture (`qualifiedName` in
 * src/lib/agent/context-snapshot.ts) is written by its language's own address rule, the InfluxQL generators'
 * `quotePath`; where those generators hold none, the address is a named host defect, never the dotted spelling, which
 * InfluxQL reads as a retention policy.
 *
 * Its own process: `@/lib/db/query-generators` is replaced so `languageGenerators` answers the InfluxQL generators
 * without `quotePath`, which the shipped registry always holds. The replacement spreads the real module captured before
 * it and calls the captured function. The provider is a fake answering one database and one measurement; nothing reads
 * a file, a mode or a line ending, and no case awaits a timer.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { LanguageGenerators } from "@/lib/db/query-generators/types";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../fixtures/provider-labels";
import { LEGACY_RUN_SESSIONS } from "../helpers/agent-engine-sessions";

const realGenerators = { ...(await import("@/lib/db/query-generators")) };
const realLanguageGenerators = realGenerators.languageGenerators;

/** The InfluxQL generators without their address rule; every other language's as they are. */
function withoutQuotePath(capabilities: Pick<ProviderCapabilities, "queryLanguage">): LanguageGenerators | undefined {
  const generators = realLanguageGenerators(capabilities);
  if (capabilities.queryLanguage !== "influxql" || generators === undefined) return generators;
  const withoutRule = { ...generators };
  delete withoutRule.quotePath;
  return withoutRule;
}

mock.module("@/lib/db/query-generators", () => ({ ...realGenerators, languageGenerators: withoutQuotePath }));

const { captureContextSnapshot } = await import("@/lib/agent/context-snapshot");

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(() => forgetHostCore());

const CAPABILITIES: ProviderCapabilities = {
  queryLanguage: "influxql",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: 8086,
  schemaRefreshPattern: "manual",
  objectKinds: [{ id: "table", role: "relation", label: "Measurement", labelPlural: "Measurements" }],
  containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
};

/** A run's context on an InfluxDB connection whose provider answers database `home` holding measurement `home`. */
function influxContext(): AgentToolContext {
  const provider = {
    type: "influxdb",
    getCapabilities: () => CAPABILITIES,
    listContainers: async () => [{ path: ["home"], name: "home", level: 0 }],
    countObjects: async () => ({ table: { count: 1 } }),
    listObjects: async (container: readonly string[]) => [
      { path: [...container, "home"], name: "home", kind: "table" },
    ],
    describeObjects: async (container: readonly string[]) => ({
      details: [{ path: [...container, "home"], columns: [], indexes: [], foreignKeys: [] }],
    }),
  } as unknown as DatabaseProvider;
  return {
    runId: "run-1",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection: { id: "conn-1", name: "Home", type: "influxdb", createdAt: new Date(0) },
    capabilities: CAPABILITIES,
    labels: TABLE_LABELS,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope("conn-1"),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, () => 1_000),
    repairs: new AgentRepairLedger(),
    sessions: LEGACY_RUN_SESSIONS,
    acquireProvider: async () => provider,
    clock: () => 1_000,
  };
}

describe("an InfluxQL measurement's address in the grounding capture", () => {
  test("an InfluxQL measurement address whose generators hold no quotePath is a named host defect, never the dotted spelling", async () => {
    // Vacuity: the shipped InfluxQL generators hold the rule this process removes.
    expect(realLanguageGenerators({ queryLanguage: "influxql" })?.quotePath).toBeFunction();

    const captured = await captureContextSnapshot(influxContext()).then(
      (capture) => capture,
      (error: unknown) => error,
    );
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe(
      "The InfluxQL generators hold no quotePath, which addresses a measurement of influxdb by its database and name: a host defect.",
    );
  });
});
