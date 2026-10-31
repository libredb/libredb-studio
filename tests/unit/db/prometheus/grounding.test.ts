/**
 * What an agent run is told about a Prometheus-compatible server that does not serve one of the read paths, replayed
 * from the VictoriaMetrics v1.152.0 captures (tests/fixtures/prometheus/victoriametrics-v1.152.0/): its `400` with
 * `unsupported path requested: "<the path>"` is the server's answer, so the grounding inventory leaves the scrape pool
 * kind out with that sentence and keeps every other kind, and the Operate run's storage reading is a refusal the
 * model reads rather than a server it could not reach, which would end the run with no report.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { type AgentToolContext, inspectOperationsTool } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { PrometheusEndpoint } from "@/lib/db/providers/timeseries/prometheus/http-transport";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import type { InboundResponse, SendRequest } from "@/lib/db/providers/timeseries/prometheus/request";
import type { ProviderExecutionContext, QueryResult } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { capture, captureVm } from "../../../helpers/prometheus-fixtures";

const ORIGIN = "http://victoriametrics.test:8428";
const TEST_ENDPOINT: PrometheusEndpoint = {
  url: (pathname, query) => {
    const url = new URL(pathname, ORIGIN);
    if (query !== undefined) url.search = query.toString();
    return url;
  },
};
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true };

const asResponse = (answer: ReturnType<typeof capture>): InboundResponse => ({
  status: answer.status,
  contentType: answer.headers["content-type"] ?? null,
  body: answer.text,
});

/**
 * The answer to each path the walk and the readings send. The three paths VictoriaMetrics does not serve answer its
 * own captured refusal; the others answer the Prometheus captures, which hold a rule group, so every kind but the
 * scrape pool has objects to list.
 */
const BY_PATH: Readonly<Record<string, () => InboundResponse>> = {
  "/api/v1/status/buildinfo": () => asResponse(capture("buildinfo")),
  "/api/v1/status/runtimeinfo": () => asResponse(captureVm("runtimeinfo")),
  "/api/v1/status/flags": () => asResponse(captureVm("flags")),
  "/api/v1/scrape_pools": () => asResponse(captureVm("scrape-pools")),
  "/api/v1/status/tsdb": () => asResponse(capture("tsdb-status-10000")),
  "/api/v1/label/__name__/values": () => asResponse(capture("label-values-names")),
  "/api/v1/series": () => asResponse(capture("series-all")),
  "/api/v1/rules": () => asResponse(capture("rules-all")),
  "/api/v1/targets": () => asResponse(capture("targets-active")),
  "/-/healthy": () => asResponse(capture("health-healthy")),
  "/-/ready": () => asResponse(capture("health-ready")),
};

let sent: string[] = [];

const send: SendRequest = (request) => {
  sent.push(request.url.pathname);
  const answer = BY_PATH[request.url.pathname];
  if (answer === undefined) return Promise.reject(new Error(`no answer for ${request.method} ${request.url.pathname}`));
  return Promise.resolve(answer());
};

const connection: DatabaseConnection = {
  id: "victoriametrics",
  name: "VictoriaMetrics",
  type: "prometheus",
  host: "victoriametrics.test",
  port: 8428,
  createdAt: new Date(0),
};

const UNSERVED_SCRAPE_POOLS =
  "The server does not serve /api/v1/scrape_pools: it answered HTTP 400 naming that path as unsupported, as " +
  "VictoriaMetrics answers a Prometheus API path it does not implement.";
const UNSERVED_RUNTIME =
  "The server does not serve /api/v1/status/runtimeinfo: it answered HTTP 400 naming that path as unsupported, as " +
  "VictoriaMetrics answers a Prometheus API path it does not implement.";

async function opened(execution: ProviderExecutionContext): Promise<PrometheusProvider> {
  const provider = new PrometheusProvider(connection, {}, execution, {
    endpoint: () => TEST_ENDPOINT,
    send,
    now: () => 1_790_000_000_000,
  });
  await provider.connect();
  sent = [];
  return provider;
}

/** The run's harness with the provider behind it, as the Firestore and S3 grounding tests build it. */
function agentContext(
  provider: PrometheusProvider,
  mode: AgentToolContext["mode"],
  workflowType: AgentToolContext["workflowType"],
): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: "run-victoriametrics",
    modelId: "unmeasured-model-for-tests",
    mode,
    workflowType,
    ...(mode === "agent" && workflowType !== "operations" ? { statementLanguage: "promql" as const } : {}),
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
}

beforeEach(() => {
  sent = [];
});

describe("grounding on a server that does not serve the scrape pool listing", () => {
  test.each([
    ["plan mode, under the operations profile", OPERATIONS, "planning"],
    ["agent mode, under the read-only profile", READ_ONLY, "agent"],
  ] as const)(
    "%s: the scrape pool kind is left out with the server's answer, every other kind kept",
    async (_name, execution, mode) => {
      const provider = await opened(execution);

      const capture = await captureContextSnapshot(agentContext(provider, mode, "investigation"));

      expect(capture.kind).toBe("captured");
      if (capture.kind !== "captured") return;
      const kinds = capture.snapshot.kinds ?? [];
      expect(kinds.find((kind) => kind.id === "scrape_pool")?.unavailable).toBe(UNSERVED_SCRAPE_POOLS);
      for (const id of ["metric", "rule_group", "target"]) {
        expect(kinds.find((kind) => kind.id === id)?.unavailable).toBeUndefined();
        expect(capture.snapshot.objects.some((object) => object.kind === id)).toBe(true);
      }
      expect(capture.snapshot.objects.some((object) => object.kind === "scrape_pool")).toBe(false);
      // The count met the refusal once, and no listing was sent to meet it again.
      expect(sent.filter((path) => path === "/api/v1/scrape_pools")).toHaveLength(1);
    },
  );
});

describe("an Operate run's storage reading on a server that does not serve the runtime read", () => {
  test("is a refusal the model reads, so the run goes on to its report", async () => {
    const provider = await opened(OPERATIONS);

    const outcome = await inspectOperationsTool(agentContext(provider, "agent", "operations"), { kind: "storage" });

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.refusal.class).toBe("database-error");
    expect(outcome.modelText).toContain(UNSERVED_RUNTIME);
    // The control: the health reading before it is the server's answer on the same handle.
    const health = await inspectOperationsTool(agentContext(provider, "agent", "operations"), { kind: "health" });
    expect(health.kind).toBe("completed");
  });
});
