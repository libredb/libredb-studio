import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import type { BaseDatabaseProvider } from "@/lib/db/base-provider";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { answersProse, modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

/**
 * What a plan run records about the statement it drafted, driven through the real loop.
 *
 * The rail renders the answer card with no capabilities, so the editor language the SERVER resolves
 * from the run's capabilities and records with the draft is the only thing that can tint an etcd draft
 * in etcd's accent (#1089, Task 27): the card answered `"unknown"` for every etcd draft before it was
 * recorded. Each drive is the real `runInvestigation` over a real ledger in a temporary directory and
 * the scripted model the isolated suite drives, on the declarations the provider ships, with a provider
 * double that lists one object so the run is grounded as a real one is.
 */

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => forgetHeldSnapshots());

/** One plan drive on `engine` whose closing prose fences `statement`, and the ledger it wrote. */
async function planDrive(
  engine: BaseDatabaseProvider,
  connection: DatabaseConnection,
  statement: string,
): Promise<readonly AgentRunEvent[]> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plan-language-"));
  dataDirs.push(dataDir);
  const capabilities = engine.getCapabilities();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error(`${connection.type} declares no object kind to list`);
  const provider = {
    listContainers: async () => [],
    countObjects: async () => ({ [listed.id]: { count: 1 } }),
    listObjects: async (_container: readonly string[], kind: string) =>
      kind === listed.id ? [{ path: ["app"], name: "app", kind }] : [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const run = await service.start({
    mode: "planning",
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "What is under the app group?",
  });
  const closing = ["Here is the read.", "", `\`\`\`${connection.type}`, statement, "```"].join("\n");
  const script = scriptedModel(answersProse(closing), answersProse(closing));

  await runInvestigation(run.runId, {
    service,
    model: await modelOver(script.fetch),
    resources: {
      connection,
      capabilities,
      labels: engine.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker,
      artifacts,
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs, () => 10_000),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => provider,
    },
  });

  const view = await store.read(run.runId);
  if (!view) throw new Error(`run ${run.runId} has no ledger`);
  return view.record.events;
}

describe("the statement a plan run drafted", () => {
  test("is recorded with the editor language the engine's capabilities resolve to", async () => {
    const etcdConnection: DatabaseConnection = {
      id: "conn_etcd",
      name: "etcd",
      type: "etcd",
      host: "127.0.0.1",
      port: 2379,
      createdAt: new Date(0),
    };
    const etcd = await planDrive(new EtcdProvider(etcdConnection), etcdConnection, "get /app/ --prefix --limit=50");

    expect(etcd.find((event) => event.kind === "plan-statement-drafted")).toMatchObject({
      sql: "get /app/ --prefix --limit=50",
      dialect: "etcd",
      language: "etcd",
    });

    // The control: another engine records its own language, so the value is resolved and not written in.
    const prometheusConnection: DatabaseConnection = {
      id: "conn_prometheus",
      name: "Prometheus",
      type: "prometheus",
      host: "localhost",
      createdAt: new Date(0),
    };
    const prometheus = await planDrive(
      new PrometheusProvider(prometheusConnection),
      prometheusConnection,
      "rate(http_requests_total[5m])",
    );

    expect(prometheus.find((event) => event.kind === "plan-statement-drafted")).toMatchObject({
      sql: "rate(http_requests_total[5m])",
      dialect: "prometheus",
      language: "promql",
    });
  });
});
