import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { modelToolJsonSchema } from "@/lib/agent/model-tool-schema";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolContext,
  type AgentToolDefinition,
  agentReadingsOf,
  inspectOperationsTool,
  selectAgentTools,
} from "@/lib/agent/tools";
import type { AgentRunRecord } from "@/lib/agent/types";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { CURATED_OPERATION_KINDS, createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";

/**
 * The curated readings agent mode is offered (FND-4 slice 3): `inspect_operations` offers each run exactly the kinds
 * its recorded engine's `ENGINE_FACETS` row declares, says nothing about every engine, and refuses any other kind by
 * name before it acquires a provider, charges the budget or makes a repair entry. No module is mocked here; a reading
 * that is taken runs through the host core, which the file installs, on the bridged session of a provider of the
 * connection's type.
 */

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

type OperationsRun = Pick<AgentRunRecord, "mode" | "workflowType" | "statementLanguage" | "engine">;

/** An agent-mode operations run on `engine`, opened in the language the manifest gives it. */
function operationsRun(engine: DatabaseType | undefined, statementLanguage?: AgentRunRecord["statementLanguage"]) {
  return {
    mode: "agent",
    workflowType: "operations",
    ...(statementLanguage === undefined ? {} : { statementLanguage }),
    ...(engine === undefined ? {} : { engine }),
  } satisfies OperationsRun;
}

function inspectOperationsOf(run: OperationsRun): AgentToolDefinition {
  const definition = selectAgentTools(run).find((tool) => tool.name === "inspect_operations");
  if (definition === undefined) throw new Error("no inspect_operations offered");
  return definition;
}

function kindEnumOf(definition: AgentToolDefinition): unknown {
  const schema = modelToolJsonSchema(definition.inputSchema) as {
    readonly properties: { readonly kind: { readonly enum: unknown } };
  };
  return schema.properties.kind.enum;
}

const OFFERED: readonly (readonly [DatabaseType, AgentRunRecord["statementLanguage"], readonly string[]])[] = [
  ["kubernetes", "kubectl", ["health"]],
  ["spark", undefined, ["health"]],
  ["duckdb", undefined, ["table-stats", "index-stats", "storage", "health"]],
  ["postgres", undefined, [...CURATED_OPERATION_KINDS]],
  ["kafka", "kafkaread", ["health"]],
];

describe("the inspect_operations definition a run is offered", () => {
  test.each(OFFERED)(
    "the inspect_operations definition on %s offers only its engine's readings",
    (engine, language, kinds) => {
      const definition = inspectOperationsOf(operationsRun(engine, language));

      expect(kindEnumOf(definition)).toEqual([...kinds]);
      expect(definition.operationId).toBe("db.operations.read");
      for (const kind of CURATED_OPERATION_KINDS) {
        expect(definition.description.includes(`${kind} (`), `${engine} ${kind}`).toBe(kinds.includes(kind));
      }
      const narrowsSchema = kinds.includes("table-stats") || kinds.includes("index-stats");
      expect(definition.description.includes("schema narrows"), engine).toBe(narrowsSchema);
    },
  );

  test("a run recorded before the engine field is offered the six kinds it was opened with", () => {
    const definition = inspectOperationsOf(operationsRun(undefined));

    expect(kindEnumOf(definition)).toEqual([...CURATED_OPERATION_KINDS]);
    expect(definition).toBe(AGENT_TOOL_DEFINITIONS.inspect_operations);
    expect(agentReadingsOf(undefined)).toEqual(CURATED_OPERATION_KINDS);
  });

  test("no inspect_operations description claims every engine", () => {
    const engines = Object.keys(ENGINE_FACETS) as DatabaseType[];
    const offering = engines.filter((engine) => ENGINE_FACETS[engine].agentReadings.length > 0);
    const descriptions = [
      AGENT_TOOL_DEFINITIONS.inspect_operations.description,
      ...offering.map((engine) => inspectOperationsOf(operationsRun(engine)).description),
    ];
    expect(descriptions.filter((description) => /every engine/i.test(description))).toEqual([]);
  });

  test("selectAgentTools hands one run the same frozen array on every call", () => {
    const first = selectAgentTools(operationsRun("duckdb"));
    const second = selectAgentTools({ ...operationsRun("duckdb") });

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(inspectOperationsOf(operationsRun("duckdb")))).toBe(true);
    expect(selectAgentTools(operationsRun("postgres"))).not.toBe(first);
    // Two engines with one list are handed one set: the tools depend on the readings alone, never on the type id.
    expect(selectAgentTools(operationsRun("sqlite"))).toBe(first);
  });

  test("a run in another workflow is handed its variant's tools, with no inspect_operations to narrow", () => {
    const tools = selectAgentTools({ mode: "agent", workflowType: "investigation", engine: "kafka" });

    expect(tools.map((tool) => tool.name)).not.toContain("inspect_operations");
  });

  test("an engine that offers no reading has no inspect_operations to build", () => {
    expect(() => selectAgentTools(operationsRun("mqtt", "mqttread"))).toThrow(
      "agent tool layer: no operations reading to offer",
    );
  });
});

const capabilities = { queryLanguage: "sql" } as unknown as ProviderCapabilities;

function readingHarness(engine: DatabaseType | undefined, type: DatabaseType) {
  const read = mock(async () => [] as unknown[]);
  const health = mock(async () => ({
    activeConnections: 1,
    databaseSize: "1 MB",
    cacheHitRatio: "N/A",
    slowQueries: [],
    activeSessions: [],
  }));
  const provider = {
    type,
    getActiveSessions: read,
    getSlowQueries: read,
    getTableStats: read,
    getIndexStats: read,
    getStorageStats: read,
    getHealth: health,
  } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => provider);
  const tracker = new ExecutionBudgetTracker();
  const repairs = new AgentRepairLedger();
  const context: AgentToolContext = {
    runId: "run-readings",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "operations",
    ...(engine === undefined ? {} : { engine }),
    actor: { sessionId: "session-1", role: "user" },
    connection: { id: "conn-1", name: "Readings", type, createdAt: new Date(0) },
    capabilities,
    labels: TABLE_LABELS,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope("conn-1"),
    tracker,
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.operations.policy.budgets.maxTotalRunMs * 2, () => 1_000),
    repairs,
    acquireProvider,
    clock: () => 1_000,
  };
  return { context, acquireProvider, tracker, repairs, read };
}

const REFUSED: readonly (readonly [DatabaseType, string, string])[] = [
  ["kafka", "sessions", '"sessions" is not a reading the Apache Kafka connection offers agent mode; it offers health.'],
  ["rabbitmq", "sessions", '"sessions" is not a reading the RabbitMQ connection offers agent mode; it offers health.'],
  [
    "trino",
    "index-stats",
    '"index-stats" is not a reading the Trino connection offers agent mode; it offers sessions, slow-queries, table-stats, storage and health.',
  ],
  [
    "etcd",
    "table-stats",
    '"table-stats" is not a reading the etcd connection offers agent mode; it offers storage and health.',
  ],
];

describe("inspectOperationsTool on a run's recorded engine", () => {
  test.each(REFUSED)(
    "inspectOperationsTool refuses a kind %s does not offer by name before it acquires a provider (%s)",
    async (engine, kind, detail) => {
      const h = readingHarness(engine, engine);
      const before = h.tracker.usage("run-readings");

      const outcome = await inspectOperationsTool(h.context, { kind });

      expect(outcome).toEqual({
        kind: "unavailable",
        reasonCode: "READING_NOT_OFFERED",
        detail,
        modelText: `This engine does not offer that reading to agent mode, so nothing was read and nothing was spent. Take one of the readings this tool offers here, named in the parentheses after this sentence, or report with what you have already read. (${detail})`,
      });
      expect(h.acquireProvider).not.toHaveBeenCalled();
      expect(h.tracker.usage("run-readings")).toEqual(before);
      expect(h.repairs.attemptsUsed).toBe(0);
    },
  );

  test("a kind the engine offers is acquired and read", async () => {
    const h = readingHarness("kafka", "kafka");

    const outcome = await inspectOperationsTool(h.context, { kind: "health" });

    expect(outcome.kind).toBe("completed");
    expect(h.acquireProvider).toHaveBeenCalledTimes(1);
  });

  test("a context without an engine reads every kind, as a run recorded before the field does", async () => {
    // A PostgreSQL connection, whose provider's session offers the sessions panel the reading is read through.
    const h = readingHarness(undefined, "postgres");

    const outcome = await inspectOperationsTool(h.context, { kind: "sessions" });

    expect(outcome.kind).toBe("completed");
    expect(h.acquireProvider).toHaveBeenCalledTimes(1);
  });

  test("a context without an engine on kafka asking for a kind whose panel kafka's row does not offer is refused as KIND_UNSUPPORTED_BY_PROVIDER, its member never called", async () => {
    // A run recorded before the engine field is offered every kind, but its reading is read through the host core,
    // which refuses a panel the session's engine does not offer, so the provider's own member is never reached.
    const h = readingHarness(undefined, "kafka");

    const outcome = await inspectOperationsTool(h.context, { kind: "sessions" });

    if (outcome.kind !== "refused") throw new Error("expected refused");
    expect(outcome.refusal).toMatchObject({ class: "reading-refused", reasonCode: "KIND_UNSUPPORTED_BY_PROVIDER" });
    expect(h.acquireProvider).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
  });

  test("a kind that is no reading at all is still refused as invalid input, before the engine is asked", async () => {
    const h = readingHarness("kafka", "kafka");

    const outcome = await inspectOperationsTool(h.context, { kind: "locks" });

    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "INVALID_TOOL_INPUT" });
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });
});
