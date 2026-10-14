import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolContext,
  agentToolDefinition,
  presentAnswerTool,
  runReadQueryTool,
  selectAgentTools,
} from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { admitKubectlStatement } from "@/lib/db/operations/kubectl-admission";
import { QueryError } from "@/lib/db/errors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes";
import { AGENT_PAGING_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";
import type { DatabaseProvider } from "@/lib/db/types";
import type { AgentRunEvent } from "@/lib/agent/types";
import type { QueryResult } from "@/lib/types";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";

/**
 * `run_read_query` on a kubectl run: its argument is `statement`, a line the reader refuses is answered with the
 * reader's own sentence before anything is sent, and an admitted line reaches the provider under `kubectl.query.read`.
 * The harness is `tools.test.ts`'s, on a Kubernetes connection.
 */

const connection = kubernetesConnection();
const kubernetes = new KubernetesProvider(connection);

/** A clock that never advances, so the deadline is never the reason anything fails. */
const frozenClock = () => 1_000;

function harness(overrides: Partial<AgentToolContext> = {}) {
  const queryReadOnly = mock(
    async (): Promise<QueryResult> => ({ rows: [{ NAME: "web-1" }], fields: ["NAME"], rowCount: 1, executionTime: 3 }),
  );
  const provider = { queryReadOnly } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => provider);
  const context: AgentToolContext = {
    runId: "run-1",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "investigation",
    statementLanguage: "kubectl",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: kubernetes.getCapabilities(),
    labels: kubernetes.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, frozenClock),
    repairs: new AgentRepairLedger(),
    acquireProvider,
    clock: () => 1_000,
    ...overrides,
  };
  return { context, queryReadOnly, acquireProvider };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

const properties = (schema: unknown): string[] => Object.keys(z.toJSONSchema(schema as z.ZodType).properties ?? {});

const STATEMENT_WORKFLOWS = ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const;

describe("run_read_query on kubectl", () => {
  test("offers a statement argument on every kubectl statement workflow, and SQL keeps its sql argument", () => {
    for (const workflow of STATEMENT_WORKFLOWS) {
      const definition = agentToolDefinition("kubectl", workflow, "run_read_query");
      expect(properties(definition.inputSchema), workflow).toEqual(["statement", "rationale"]);
      expect(definition.operationId, workflow).toBe("kubectl.query.read");
      expect(agentToolDefinition(undefined, workflow, "run_read_query"), workflow).toBe(
        AGENT_TOOL_DEFINITIONS.run_read_query,
      );
    }
    expect(properties(agentToolDefinition(undefined, "investigation", "run_read_query").inputSchema)).toEqual([
      "sql",
      "rationale",
    ]);
  });

  test("a kubectl investigation is offered run_read_query and compose_report, and its read takes a statement", () => {
    const offered = selectAgentTools({ mode: "agent", workflowType: "investigation", statementLanguage: "kubectl" });
    expect(offered.map((tool) => tool.name)).toEqual(["run_read_query", "compose_report"]);
    const read = offered.find((tool) => tool.name === "run_read_query");
    expect(properties(read?.inputSchema)).toContain("statement");
  });

  test("a kubectl workflow overrides only the tool it names differently", () => {
    expect(agentToolDefinition("kubectl", "investigation", "compose_report")).toBe(
      AGENT_TOOL_DEFINITIONS.compose_report,
    );
    expect(agentToolDefinition("kubectl", "operations", "inspect_operations")).toBe(
      AGENT_TOOL_DEFINITIONS.inspect_operations,
    );
  });

  test("an admitted read reaches the provider under kubectl.query.read", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, { statement: "get pods -n shop" });
    expect(outcome.kind).toBe("completed");
    expect(h.queryReadOnly).toHaveBeenCalledWith("get pods -n shop", expect.any(Object), undefined);
    if (outcome.kind === "completed") expect(outcome.artifact.operationId).toBe("kubectl.query.read");
  });

  test("a refused line is answered with the reader's own sentence and reaches nothing", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, { statement: "delete pod web-1 -n shop" });
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "STATEMENT_NOT_ADMITTED" });
    const sentence = admitKubectlStatement("delete pod web-1 -n shop")?.message;
    expect(sentence).toBeString();
    expect(outcome.modelText).toContain(sentence as string);
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("the paging clause is refused before the provider", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, {
      statement: "get pods -n shop\n# libredb:page offset=0 limit=50",
    });
    expect(outcome.modelText).toContain(AGENT_PAGING_SENTENCE);
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("an sql argument on kubectl is invalid input", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, { sql: "get pods" });
    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "INVALID_TOOL_INPUT" });
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });
});

describe("the kubectl adapter's server half on run_read_query", () => {
  function failingHarness(message: string) {
    const queryReadOnly = mock(async (): Promise<QueryResult> => {
      throw new QueryError(message, "kubernetes");
    });
    return harness({ acquireProvider: mock(async () => ({ queryReadOnly }) as unknown as DatabaseProvider) });
  }

  test("a read refused past the row budget is advised in get's own flags, never with LIMIT", async () => {
    const h = failingHarness("Read-only execution exceeded the row budget: 1000 rows > 200 allowed");
    const outcome = await runReadQueryTool(h.context, { statement: "get pods -A" });
    for (const flag of ["-n", "-l", "--field-selector", "200"]) expect(outcome.modelText).toContain(flag);
    expect(outcome.modelText).not.toContain("LIMIT");
  });

  test("the repair ledger knows one read written two ways, and tells a different namespace apart", async () => {
    const h = failingHarness("pods is forbidden");
    await runReadQueryTool(h.context, { statement: "get pods -n shop" });
    const again = await runReadQueryTool(h.context, { statement: "kubectl get pods --namespace=shop" });
    expect(again).toMatchObject({ kind: "unavailable", reasonCode: "STATEMENT_ALREADY_FAILED" });
    const other = await runReadQueryTool(h.context, { statement: "get pods -n web" });
    expect(other).toMatchObject({ kind: "refused" });
  });
});

describe("present_answer on a kubectl data-analysis run", () => {
  /** A kubectl grid as the provider answers it: every cell is text, quantities included. */
  const GRID: QueryResult = {
    rows: [
      { NAME: "web-1", STATUS: "250m" },
      { NAME: "web-2", STATUS: "500m" },
    ],
    fields: ["NAME", "STATUS"],
    rowCount: 2,
    executionTime: 3,
  };

  function analysis() {
    const queryReadOnly = mock(async (): Promise<QueryResult> => GRID);
    return harness({
      workflowType: "data-analysis",
      acquireProvider: mock(async () => ({ queryReadOnly }) as unknown as DatabaseProvider),
    });
  }

  /** A read this run took, with the drafted statement its step carries. */
  async function readWithLedger(context: AgentToolContext) {
    const outcome = await runReadQueryTool(context, { statement: "get pods -n shop" });
    if (outcome.kind !== "completed") throw new Error(`expected a completed read, got ${outcome.kind}`);
    const events: AgentRunEvent[] = [
      { kind: "statement-drafted", atMs: 1, stepId: "step_1", sql: "get pods -n shop", rationale: "r" },
      { kind: "tool-completed", atMs: 2, stepId: "step_1", artifact: outcome.artifact },
    ];
    return { artifact: outcome.artifact, events };
  }

  test("a kubectl data-analysis run is offered run_read_query, present_answer and compose_report", () => {
    const offered = selectAgentTools({ mode: "agent", workflowType: "data-analysis", statementLanguage: "kubectl" });
    expect(offered.map((tool) => tool.name)).toEqual(["run_read_query", "present_answer", "compose_report"]);
  });

  test("a completed kubectl.query.read whose step drafted a statement is presented as a table", async () => {
    const h = analysis();
    const { artifact, events } = await readWithLedger(h.context);
    expect(artifact.operationId).toBe("kubectl.query.read");

    const answer = presentAnswerTool(
      h.context,
      { runId: h.context.runId, events, autoExecute: false },
      { artifact: artifact.correlationId, presentation: { kind: "table" } },
    );

    if (answer.kind !== "answered") throw new Error(`expected an answer, got ${answer.kind}`);
    expect(answer.answer.presentation).toEqual({ kind: "table" });
    expect(answer.answer.sql).toBe("get pods -n shop");
    expect(answer.answer.handover).toBe("none");
  });

  test("a chart over a kubectl text grid is refused with the chart-column refusal", async () => {
    const h = analysis();
    const { artifact, events } = await readWithLedger(h.context);

    const answer = presentAnswerTool(
      h.context,
      { runId: h.context.runId, events, autoExecute: false },
      {
        artifact: artifact.correlationId,
        presentation: { kind: "chart", spec: { type: "bar", x: "NAME", y: ["STATUS"], caption: "CPU by pod" } },
      },
    );

    expect(answer).toMatchObject({ kind: "unavailable", reasonCode: "CHART_COLUMN_NOT_NUMERIC" });
  });

  test("a cluster.usage.read artifact is not a data read, so it cannot be the answer", async () => {
    const h = analysis();
    const { artifact } = await readWithLedger(h.context);
    const usage = { ...artifact, correlationId: "usage-1", operationId: "cluster.usage.read" };
    const events: AgentRunEvent[] = [{ kind: "tool-completed", atMs: 2, stepId: "step_9", artifact: usage }];

    const answer = presentAnswerTool(
      h.context,
      { runId: h.context.runId, events, autoExecute: false },
      { artifact: "usage-1", presentation: { kind: "table" } },
    );

    expect(answer).toMatchObject({ kind: "unavailable", reasonCode: "ANSWER_NOT_A_DATA_READ" });
  });
});
