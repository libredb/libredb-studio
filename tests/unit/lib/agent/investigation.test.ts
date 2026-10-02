import { afterAll, describe, expect, test } from "bun:test";
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
import type { DatabaseProvider, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { answersProse, modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

/**
 * What a plan run records about the statement it drafted, driven through the real loop.
 *
 * The rail renders the answer card with no capabilities, so the editor language the SERVER resolves
 * from the run's capabilities and records with the draft is the only thing that can tint an etcd draft
 * in etcd's accent (#1089, Task 27): the card answered `"unknown"` for every etcd draft before it was
 * recorded. Each drive is the real `runInvestigation` over a real ledger in a temporary directory and
 * the scripted model the isolated suite drives, on the declarations it is handed, with a provider
 * double that lists one object so the run is grounded as a real one is.
 */

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The engine declarations a drive is handed, as `AgentToolContext` carries them. */
interface Declarations {
  readonly capabilities: ProviderCapabilities;
  readonly labels: ProviderLabels;
}

/**
 * One plan drive on `connection` holding `declared`, whose closing prose fences `statement` under the
 * connection's own tag, and the ledger it wrote.
 */
async function planDrive(
  connection: DatabaseConnection,
  declared: Declarations,
  statement: string,
): Promise<readonly AgentRunEvent[]> {
  // A cold process per drive: a drive on a connection an earlier drive read is grounded on that
  // reading instead of taking its own.
  forgetHeldSnapshots();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plan-language-"));
  dataDirs.push(dataDir);
  const { capabilities, labels } = declared;
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
      labels,
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
  test("is recorded with the editor language the capabilities the drive holds resolve to", async () => {
    const connection: DatabaseConnection = {
      id: "conn_etcd",
      name: "etcd",
      type: "etcd",
      host: "127.0.0.1",
      port: 2379,
      createdAt: new Date(0),
    };
    const engine = new EtcdProvider(connection);
    const etcd: Declarations = { capabilities: engine.getCapabilities(), labels: engine.getLabels() };
    const statement = "get /app/ --prefix --limit=50";

    const drafted = await planDrive(connection, etcd, statement);

    expect(drafted.find((event) => event.kind === "plan-statement-drafted")).toMatchObject({
      sql: statement,
      dialect: "etcd",
      language: "etcd",
    });

    // The control: the same connection and draft on etcd's own declaration, with PromQL declared in
    // place of its dialect. The record follows the capabilities, so the language is resolved and is
    // neither written in nor read off the connection's type. Built from etcd's declaration rather than
    // from another provider, which this provider's change does not import.
    const promql = await planDrive(
      connection,
      { ...etcd, capabilities: { ...etcd.capabilities, queryDialect: undefined, queryLanguage: "promql" } },
      statement,
    );

    expect(promql.find((event) => event.kind === "plan-statement-drafted")).toMatchObject({
      sql: statement,
      dialect: "etcd",
      language: "promql",
    });
  });
});
