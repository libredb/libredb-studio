import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent } from "@/lib/agent/types";
import { foldLedgerEntries } from "@/components/agent/timeline";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import type { DatabaseProvider, QueryResult } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

/**
 * What a turn's spend does to the ledger, the ceiling and the meter, driven through the
 * REAL run loop over the real SDK.
 *
 * The transport is scripted, so the figures are this file's rather than a live server's:
 * what is under test is where those figures GO, not what a model costs.
 */

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const USAGE = { input: 1_200, output: 300, cached: 900 };

const chunk = (body: Record<string, unknown>): string => `data: ${JSON.stringify(body)}\n\n`;

/**
 * One OpenAI-shaped answer, with or without the usage block a server sends when
 * `include_usage` is set. `usage: null` is the provider that reports nothing.
 */
function answer(text: string, usage: { input: number; output: number } | null): Response {
  const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-4o-mini" };
  let body = chunk({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  body += chunk({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(usage === null
      ? {}
      : {
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          },
        }),
  });
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const CLOSING = ["Here is the read.", "", "```etcd", "get /app/ --prefix", "```"].join("\n");

interface Driven {
  readonly events: readonly AgentRunEvent[];
  readonly status: string;
  readonly stopReason: string;
  readonly store: AgentRunStore;
  readonly runId: string;
}

/** One planning drive over a temporary ledger, with the transport scripted. */
async function drive(options: {
  readonly withUsage: boolean;
  readonly maxTokens?: number;
  /**
   * `planning` ends the run on its own once the model stops, so it never reaches a
   * second turn; `agent` keeps going, which is what reaches the ceiling check.
   */
  readonly mode?: "planning" | "agent";
}): Promise<Driven> {
  forgetHeldSnapshots();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-token-budget-"));
  dataDirs.push(dataDir);
  const connection: DatabaseConnection = {
    id: "conn_etcd",
    name: "etcd",
    type: "etcd",
    host: "127.0.0.1",
    port: 2379,
    createdAt: new Date(0),
  };
  const engine = new EtcdProvider(connection);
  const capabilities = engine.getCapabilities();
  const labels = engine.getLabels();
  const [listed] = capabilities.objectKinds ?? [];
  if (listed === undefined) throw new Error("etcd declares no object kind to list");
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
    mode: options.mode ?? "planning",
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "What is under the app group?",
  });
  const usage = options.withUsage ? { input: USAGE.input, output: USAGE.output } : null;
  const script = scriptedModel(
    () => answer(CLOSING, usage),
    () => answer(CLOSING, usage),
  );

  const result = await runInvestigation(run.runId, {
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
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });

  const view = await store.read(run.runId);
  if (!view) throw new Error(`run ${run.runId} has no ledger`);
  return {
    events: view.record.events,
    status: result.status,
    stopReason: result.stopReason ?? "none",
    store,
    runId: run.runId,
  };
}

/** The ledger's entries, read back the way the rail reads them. */
async function entriesOf(store: AgentRunStore, runId: string) {
  const reader = (await store.stream(runId)).getReader();
  const entries = [];
  let reading = true;
  while (reading) {
    const next = await reader.read();
    if (next.done) reading = false;
    else entries.push(next.value);
  }
  return entries;
}

describe("a turn's spend in the run loop", () => {
  test("is written to the ledger as one model-turn entry with the server's figures", async () => {
    const driven = await drive({ withUsage: true });
    const turns = driven.events.filter((event) => event.kind === "model-turn");
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0]).toMatchObject({ inputTokens: USAGE.input, outputTokens: USAGE.output });
  });

  test("ends the run at the ceiling, after the first turn that crossed it", async () => {
    const driven = await drive({ withUsage: true, maxTokens: 10, mode: "agent" });
    expect(driven.status).toBe("failed");
    expect(driven.stopReason).toBe("token-limit");
    expect(driven.events.filter((event) => event.kind === "model-turn").length).toBe(1);
  });

  test("still takes one turn when the ceiling is already gone, and caps that turn at the per-call limit", async () => {
    // A ceiling of zero is the shape a resumed run with an exhausted budget presents: no
    // room left for a next turn, and one turn still owed so the run can say what it has.
    const driven = await drive({ withUsage: true, maxTokens: 0, mode: "agent" });
    expect(driven.events.filter((event) => event.kind === "model-turn").length).toBe(1);
    expect(driven.stopReason).toBe("token-limit");
  });

  test("writes nothing when the provider reports nothing, so neither the ledger nor the ceiling invents a figure", async () => {
    const driven = await drive({ withUsage: false, maxTokens: 10 });
    expect(driven.events.some((event) => event.kind === "model-turn")).toBe(false);
    expect(driven.stopReason).not.toBe("token-limit");
  });

  test("shows one token gauge on the meter and no timeline row per turn", async () => {
    const driven = await drive({ withUsage: true });
    const timeline = foldLedgerEntries(await entriesOf(driven.store, driven.runId));
    const gauge = timeline.budget.find((entry) => entry.id === "tokens");
    const turns = driven.events.filter((event) => event.kind === "model-turn");
    const expected = turns.reduce(
      (sum, event) => (event.kind === "model-turn" ? sum + event.inputTokens + event.outputTokens : sum),
      0,
    );
    expect(gauge).toMatchObject({
      used: expected,
      limit: AGENT_WORKFLOW_BUDGETS.investigation.maxTokensPerRun,
      unit: "tokens",
    });
    expect(timeline.items.some((item) => item.headline.startsWith("Turn "))).toBe(false);
  });

  test("draws no token gauge for a run whose provider reported nothing", async () => {
    const driven = await drive({ withUsage: false });
    const timeline = foldLedgerEntries(await entriesOf(driven.store, driven.runId));
    expect(timeline.budget.some((entry) => entry.id === "tokens")).toBe(false);
  });
});
