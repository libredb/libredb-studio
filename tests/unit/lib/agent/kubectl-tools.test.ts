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
  recommendChangeTool,
  runReadQueryTool,
  selectAgentTools,
} from "@/lib/agent/tools";
import { inspectUsageTool, profileWorkloadsTool } from "@/lib/agent/languages/kubectl/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { admitKubectlStatement } from "@/lib/db/operations/kubectl-admission";
import { QueryError } from "@/lib/db/errors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes";
import { AGENT_PAGING_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";
import { CLUSTER_USAGE_FIELDS, WORKLOAD_PROFILE_FIELDS } from "@/lib/db/providers/platform/kubernetes/agent-readings";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type {
  ClusterUsageReading,
  DatabaseProvider,
  ReadOnlyStatementBudget,
  WorkloadProfileReading,
} from "@/lib/db/types";
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

describe("inspect_usage", () => {
  /*
    The tool layer only. A drive that records `usage-read` and `usage-unavailable` on the ledger needs a variant that
    offers this tool, and no kubectl variant does until the resource-efficiency variant lands; that drive test is
    written there, against the variant, rather than here against a handler exported for tests.
  */

  const USAGE_ROW = {
    namespace: "shop",
    ownerKind: "Deployment",
    ownerName: "web",
    pod: "web-1",
    container: "app",
    cpuMillicores: 120,
    memoryBytes: 52_428_800,
    cpuRequestMillicores: 250,
    cpuLimitMillicores: 500,
    memoryRequestBytes: 134_217_728,
    memoryLimitBytes: 268_435_456,
    cpuRequestRatio: 0.48,
    memoryRequestRatio: 0.390625,
    window: "30s",
    timestamp: "2026-10-14T09:00:00Z",
  };

  const ROWS: ClusterUsageReading = {
    kind: "rows",
    result: { rows: [USAGE_ROW], fields: [...CLUSTER_USAGE_FIELDS], rowCount: 1, executionTime: 3 },
  };

  function usageHarness(answer: () => Promise<ClusterUsageReading>) {
    const readClusterUsage = mock(answer);
    const h = harness({
      workflowType: "query-optimization",
      acquireProvider: mock(async () => ({ readClusterUsage }) as unknown as DatabaseProvider),
    });
    return { ...h, readClusterUsage };
  }

  test("one audited call, one statement charge, under cluster.usage.read, rows fenced", async () => {
    const h = usageHarness(async () => ROWS);
    const outcome = await inspectUsageTool(h.context, { namespace: "shop", selector: "app=web" });

    if (outcome.kind !== "completed") throw new Error(`expected a completed reading, got ${outcome.kind}`);
    expect(outcome.artifact.operationId).toBe("cluster.usage.read");
    expect(outcome.artifact.summary.rowCount).toBe(1);
    expect(h.context.tracker.usage(h.context.runId).executedStatements).toBe(1);
    expect(h.readClusterUsage).toHaveBeenCalledTimes(1);
    expect(h.readClusterUsage).toHaveBeenCalledWith({ namespace: "shop", selector: "app=web" }, expect.any(Object));
    // The cells are the cluster's content, so they reach the model inside the untrusted fence.
    expect(outcome.modelText).toContain("BEGIN UNTRUSTED");
    expect(outcome.modelText).toContain("web-1");
  });

  test("the reading is handed the run's read allowance in its budget, as every read of the run is", async () => {
    const h = usageHarness(async () => ROWS);
    const readAllowance = new RunReadAllowance(10);
    await inspectUsageTool({ ...h.context, readAllowance }, { namespace: "shop" });

    expect(
      ((h.readClusterUsage.mock.calls[0] as unknown[] | undefined)?.[1] as ReadOnlyStatementBudget).readAllowance,
    ).toBe(readAllowance);
  });

  test("metrics unavailable is a reading-refused METRICS_UNAVAILABLE naming metrics-server", async () => {
    const h = usageHarness(async () => ({ kind: "metrics-unavailable" }));
    const outcome = await inspectUsageTool(h.context, { namespace: "shop" });

    if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject({ class: "reading-refused", reasonCode: "METRICS_UNAVAILABLE" });
    expect(outcome.modelText).toContain("metrics-server");
    expect(outcome.modelText).toContain("metrics.k8s.io");
    // The call was made, so it was charged.
    expect(h.context.tracker.usage(h.context.runId).executedStatements).toBe(1);
  });

  test("over the ceiling is READING_OVER_BUDGET with advice to narrow by namespace or selector", async () => {
    const h = usageHarness(async () => ({ kind: "over-ceiling" }));
    const outcome = await inspectUsageTool(h.context, { namespace: "shop" });

    if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject({ class: "reading-refused", reasonCode: "READING_OVER_BUDGET" });
    expect(outcome.modelText).toContain("500 rows");
    expect(outcome.modelText).toContain("selector");
    expect(outcome.modelText).toContain("namespace");
    expect(outcome.modelText).not.toContain("smaller limit");
  });

  test("rows past the byte budget are READING_OVER_BUDGET with a byte sentence, never the generic limit advice", async () => {
    const wide = { ...USAGE_ROW, ownerName: "w".repeat(4_000) };
    const maxResultBytes = AGENT_WORKFLOW_BUDGETS["query-optimization"].policy.budgets.maxResultBytes;
    // Few enough rows to sit under the 500-row ceiling, wide enough to pass the byte budget.
    const count = Math.ceil(maxResultBytes / JSON.stringify(wide).length) + 1;
    expect(count).toBeLessThan(500);
    const h = usageHarness(async () => ({
      kind: "rows",
      result: { rows: Array(count).fill(wide), fields: [...CLUSTER_USAGE_FIELDS], rowCount: count, executionTime: 3 },
    }));

    const outcome = await inspectUsageTool(h.context, { namespace: "shop" });

    if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject({ class: "reading-refused", reasonCode: "READING_OVER_BUDGET" });
    expect(outcome.modelText).toContain(`${maxResultBytes} bytes`);
    expect(outcome.modelText).toContain("selector");
    expect(outcome.modelText).not.toContain("smaller limit");
  });

  test("a provider without readClusterUsage is KIND_UNSUPPORTED_BY_PROVIDER", async () => {
    const h = harness({ workflowType: "query-optimization" });
    const outcome = await inspectUsageTool(h.context, { namespace: "shop" });

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { class: "reading-refused", reasonCode: "KIND_UNSUPPORTED_BY_PROVIDER" },
    });
    expect(h.queryReadOnly).not.toHaveBeenCalled();
  });

  test("an invalid namespace is invalid input and reaches nothing", async () => {
    const h = usageHarness(async () => ROWS);
    for (const input of [{ namespace: "Shop" }, { namespace: "shop", selector: "  " }, { namespace: "shop", x: 1 }]) {
      const outcome = await inspectUsageTool(h.context, input);
      expect(outcome, JSON.stringify(input)).toMatchObject({ kind: "unavailable", reasonCode: "INVALID_TOOL_INPUT" });
    }
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("two selectors differing only in case are two calls to the repair ledger", async () => {
    const h = usageHarness(async () => {
      throw new QueryError("pods is forbidden", "kubernetes");
    });

    const first = await inspectUsageTool(h.context, { namespace: "shop", selector: "app=Web" });
    expect(first).toMatchObject({ kind: "refused", refusal: { class: "database-error" } });
    const same = await inspectUsageTool(h.context, { namespace: "shop", selector: "app=Web" });
    expect(same).toMatchObject({ kind: "unavailable", reasonCode: "STATEMENT_ALREADY_FAILED" });
    const otherCase = await inspectUsageTool(h.context, { namespace: "shop", selector: "app=web" });
    expect(otherCase).toMatchObject({ kind: "refused", refusal: { class: "database-error" } });
    expect(h.readClusterUsage).toHaveBeenCalledTimes(2);
  });

  test("the tool is defined under cluster.usage.read with a namespace and an optional selector", () => {
    const definition = AGENT_TOOL_DEFINITIONS.inspect_usage;
    expect(definition.operationId).toBe("cluster.usage.read");
    expect(properties(definition.inputSchema)).toEqual(["namespace", "selector"]);
    expect(definition.description).toContain("500");
  });
});

describe("profile_workloads", () => {
  /* The tool layer only; the drive that writes `workloads-profiled` is in `investigation.test.ts`. */

  const WORKLOAD_ROW = {
    kind: "Deployment",
    name: "web",
    desired: 3,
    ready: 2,
    lastSchedule: null,
    podsNotReady: 1,
    restarts: 4,
    lastTerminationReason: "OOMKilled",
    lastTerminationAt: "2026-10-14T08:00:00Z",
    withoutRequests: 0,
    withoutLimits: 1,
    withoutReadinessProbe: 1,
    withoutLivenessProbe: 1,
    warningEvents: "BackOff=3",
  };

  const ROWS: WorkloadProfileReading = {
    kind: "rows",
    result: { rows: [WORKLOAD_ROW], fields: [...WORKLOAD_PROFILE_FIELDS], rowCount: 1, executionTime: 3 },
  };

  function profileHarness(answer: () => Promise<WorkloadProfileReading>) {
    const readWorkloadProfile = mock(answer);
    const h = harness({
      workflowType: "database-assessment",
      acquireProvider: mock(async () => ({ readWorkloadProfile }) as unknown as DatabaseProvider),
    });
    return { ...h, readWorkloadProfile };
  }

  test("one audited call, one statement charge, under cluster.workloads.read, rows fenced", async () => {
    const h = profileHarness(async () => ROWS);
    const outcome = await profileWorkloadsTool(h.context, { namespace: "shop" });

    if (outcome.kind !== "completed") throw new Error(`expected a completed profile, got ${outcome.kind}`);
    expect(outcome.artifact.operationId).toBe("cluster.workloads.read");
    expect(outcome.artifact.summary.rowCount).toBe(1);
    expect(h.context.tracker.usage(h.context.runId).executedStatements).toBe(1);
    expect(h.readWorkloadProfile).toHaveBeenCalledTimes(1);
    expect(h.readWorkloadProfile).toHaveBeenCalledWith({ namespace: "shop" }, expect.any(Object));
    expect(outcome.modelText).toContain("BEGIN UNTRUSTED");
    expect(outcome.modelText).toContain("OOMKilled");
  });

  test("the profile is handed the run's read allowance in its budget, as every read of the run is", async () => {
    const h = profileHarness(async () => ROWS);
    const readAllowance = new RunReadAllowance(10);
    await profileWorkloadsTool({ ...h.context, readAllowance }, { namespace: "shop" });

    expect(
      ((h.readWorkloadProfile.mock.calls[0] as unknown[] | undefined)?.[1] as ReadOnlyStatementBudget).readAllowance,
    ).toBe(readAllowance);
  });

  test("an empty namespace is a completed profile of no rows", async () => {
    const h = profileHarness(async () => ({
      kind: "rows",
      result: { rows: [], fields: [...WORKLOAD_PROFILE_FIELDS], rowCount: 0, executionTime: 1 },
    }));
    const outcome = await profileWorkloadsTool(h.context, { namespace: "empty" });

    expect(outcome).toMatchObject({ kind: "completed", artifact: { summary: { rowCount: 0 } } });
  });

  test("over the ceiling is READING_OVER_BUDGET with advice to narrow by namespace, never a smaller limit", async () => {
    const h = profileHarness(async () => ({ kind: "over-ceiling" }));
    const outcome = await profileWorkloadsTool(h.context, { namespace: "shop" });

    if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject({ class: "reading-refused", reasonCode: "READING_OVER_BUDGET" });
    expect(outcome.modelText).toContain("500 workloads");
    expect(outcome.modelText).toContain("namespace");
    expect(outcome.modelText).not.toContain("smaller limit");
    expect(outcome.modelText).not.toContain("selector");
    expect(h.context.tracker.usage(h.context.runId).executedStatements).toBe(1);
  });

  test("rows past the byte budget are READING_OVER_BUDGET with a byte sentence", async () => {
    const wide = { ...WORKLOAD_ROW, name: "w".repeat(4_000) };
    const maxResultBytes = AGENT_WORKFLOW_BUDGETS["database-assessment"].policy.budgets.maxResultBytes;
    const count = Math.ceil(maxResultBytes / JSON.stringify(wide).length) + 1;
    expect(count).toBeLessThan(500);
    const h = profileHarness(async () => ({
      kind: "rows",
      result: {
        rows: Array(count).fill(wide),
        fields: [...WORKLOAD_PROFILE_FIELDS],
        rowCount: count,
        executionTime: 3,
      },
    }));

    const outcome = await profileWorkloadsTool(h.context, { namespace: "shop" });

    if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.refusal).toMatchObject({ class: "reading-refused", reasonCode: "READING_OVER_BUDGET" });
    expect(outcome.modelText).toContain(`${maxResultBytes} bytes`);
    expect(outcome.modelText).toContain("namespace");
    expect(outcome.modelText).not.toContain("smaller limit");
  });

  test("a provider without readWorkloadProfile is KIND_UNSUPPORTED_BY_PROVIDER", async () => {
    const h = harness({ workflowType: "database-assessment" });
    const outcome = await profileWorkloadsTool(h.context, { namespace: "shop" });

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { class: "reading-refused", reasonCode: "KIND_UNSUPPORTED_BY_PROVIDER" },
    });
    expect(h.queryReadOnly).not.toHaveBeenCalled();
  });

  test("an invalid namespace, or a selector, is invalid input and reaches nothing", async () => {
    const h = profileHarness(async () => ROWS);
    for (const input of [{ namespace: "Shop" }, { namespace: "shop", selector: "app=web" }, {}]) {
      const outcome = await profileWorkloadsTool(h.context, input);
      expect(outcome, JSON.stringify(input)).toMatchObject({ kind: "unavailable", reasonCode: "INVALID_TOOL_INPUT" });
    }
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("a failed profile asked again is refused by the repair ledger, and another namespace is not", async () => {
    const h = profileHarness(async () => {
      throw new QueryError("deployments.apps is forbidden", "kubernetes");
    });

    const first = await profileWorkloadsTool(h.context, { namespace: "shop" });
    expect(first).toMatchObject({ kind: "refused", refusal: { class: "database-error" } });
    const same = await profileWorkloadsTool(h.context, { namespace: "shop" });
    expect(same).toMatchObject({ kind: "unavailable", reasonCode: "STATEMENT_ALREADY_FAILED" });
    const other = await profileWorkloadsTool(h.context, { namespace: "web" });
    expect(other).toMatchObject({ kind: "refused", refusal: { class: "database-error" } });
    expect(h.readWorkloadProfile).toHaveBeenCalledTimes(2);
  });

  test("the tool is defined under cluster.workloads.read with a namespace alone", () => {
    const definition = AGENT_TOOL_DEFINITIONS.profile_workloads;
    expect(definition.operationId).toBe("cluster.workloads.read");
    expect(properties(definition.inputSchema)).toEqual(["namespace"]);
    expect(definition.description).toContain("More than 500 workloads are refused.");
  });

  test("a kubectl assessment is offered run_read_query, profile_workloads and compose_report", () => {
    const offered = selectAgentTools({
      mode: "agent",
      workflowType: "database-assessment",
      statementLanguage: "kubectl",
    });
    expect(offered.map((tool) => tool.name)).toEqual(["run_read_query", "profile_workloads", "compose_report"]);
  });
});

describe("recommend_change on kubectl", () => {
  /** A usage reading this run took, so a resources change has something of the run's own to cite. */
  const USAGE_READ: AgentRunEvent = {
    kind: "usage-read",
    atMs: 2,
    artifact: {
      correlationId: "u1",
      runId: "run-1",
      operationId: "cluster.usage.read",
      summary: { rowCount: 1, columnNames: ["container"], elapsedMs: 3 },
    },
    namespace: "shop",
  };

  const RESOURCES = {
    change: "resources",
    namespace: "shop",
    ownerKind: "Deployment",
    ownerName: "web",
    container: "web",
    current: { requests: { cpu: "500m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    proposed: { requests: { cpu: "150m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    rationale: "r",
    evidence: [{ source: "artifact", correlationId: "u1" }],
  };

  const optimization = () => harness({ workflowType: "query-optimization" });
  const recommend = (input: unknown) => {
    const h = optimization();
    return recommendChangeTool(h.context, { runId: h.context.runId, events: [USAGE_READ] }, input);
  };

  test("a resources change citing a usage reading of this run goes through the schema and is recorded, with no statement", () => {
    const outcome = recommend(RESOURCES);

    if (outcome.kind !== "recommended") throw new Error(`expected a recommendation, got ${outcome.kind}`);
    expect(outcome.recommendation.change).toBe("resources");
    expect("statement" in outcome.recommendation).toBe(false);
    expect(outcome.recommendation).toMatchObject({
      namespace: "shop",
      ownerKind: "Deployment",
      ownerName: "web",
      container: "web",
      proposed: RESOURCES.proposed,
    });
    expect(outcome.modelText).toBe(
      "Recommendation recorded: new requests and limits for container web of Deployment/web, offered to the user and not applied. It is theirs to apply.",
    );
  });

  test("a container under a custom resource's owner kind, as inspect_usage reports it, is recorded", () => {
    const outcome = recommend({ ...RESOURCES, ownerKind: "Cluster", ownerName: "pg" });

    if (outcome.kind !== "recommended") throw new Error(`expected a recommendation, got ${outcome.kind}`);
    expect(outcome.recommendation).toMatchObject({ ownerKind: "Cluster", ownerName: "pg" });
  });

  test("an empty owner kind is invalid input", () => {
    expect(recommend({ ...RESOURCES, ownerKind: "" })).toMatchObject({
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
    });
  });

  test.each(["250 millicores", "1.5.0", "", "-"])("a quantity that is not one (%s) is invalid input", (quantity) => {
    const outcome = recommend({
      ...RESOURCES,
      proposed: { requests: { cpu: quantity, memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    });

    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "INVALID_TOOL_INPUT" });
  });

  test("an index card is not offered on kubectl: change index is invalid input", () => {
    const outcome = recommend({
      change: "index",
      statement: "CREATE INDEX ix ON orders (customer_id)",
      rationale: "r",
      evidence: [{ source: "artifact", correlationId: "u1" }],
    });

    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "INVALID_TOOL_INPUT" });
  });

  test("evidence the run did not produce is UNVERIFIABLE_EVIDENCE", () => {
    const outcome = recommend({ ...RESOURCES, evidence: [{ source: "artifact", correlationId: "nope" }] });

    expect(outcome).toMatchObject({ kind: "unavailable", reasonCode: "UNVERIFIABLE_EVIDENCE" });
  });

  test("the kubectl query-optimization definition takes the resources schema, and SQL keeps the statement one", () => {
    const kubectl = agentToolDefinition("kubectl", "query-optimization", "recommend_change");
    expect(properties(kubectl.inputSchema)).toEqual([
      "change",
      "namespace",
      "ownerKind",
      "ownerName",
      "container",
      "current",
      "proposed",
      "rationale",
      "evidence",
    ]);
    expect(kubectl.description).toContain("inspect_usage");
    expect(agentToolDefinition("sql", "query-optimization", "recommend_change")).toBe(
      AGENT_TOOL_DEFINITIONS.recommend_change,
    );
  });
});
