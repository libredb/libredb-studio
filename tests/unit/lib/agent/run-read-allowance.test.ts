import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_RUN_READ_ALLOWANCE, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { READ_ALLOWANCE_PREFIX, type RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseProvider, ProviderCapabilities, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";
import {
  answersProse,
  callsTool,
  modelOver,
  promptText,
  type ScriptedTurn,
  scriptedModel,
  type Turn,
} from "../../../isolated/fixtures/agent-scripted-model";

/**
 * The run read allowance, driven through the real loop: a provider double that charges the allowance its budget
 * carries, as an engine that bills every read will, over a PostgreSQL connection's declarations, whose grounding is
 * a catalog read through the same `queryReadOnly` the model's statements take.
 */

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const connection: DatabaseConnection = { id: "conn_pg", name: "Orders", type: "postgres", createdAt: new Date(0) };
const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

/** The model's own statement, told apart from the grounding's catalog statements by its text. */
const MODEL_SQL = "SELECT count(*) FROM orders";

/** One read the double served: what it was asked, the allowance it was handed, and what that had left. */
interface ChargedRead {
  readonly sql: string;
  readonly allowance: RunReadAllowance | undefined;
  readonly remainingBefore: number | undefined;
}

/**
 * A provider double shared by every drive that is handed it, as the provider cache shares one: each read charges
 * `costOf(sql)` billed reads to the allowance its budget carries, before it answers, and is recorded.
 */
function billingProvider(costOf: (sql: string) => number): { provider: DatabaseProvider; reads: ChargedRead[] } {
  const reads: ChargedRead[] = [];
  const provider = {
    queryReadOnly: async (sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult> => {
      const allowance = budget.readAllowance;
      reads.push({ sql, allowance, remainingBefore: allowance?.remaining() });
      const cost = costOf(sql);
      // An engine that bills nothing for a read never charges.
      if (cost > 0) allowance?.charge(cost, "the read");
      return { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };
    },
    listContainers: async () => [],
    countObjects: async () => ({}),
    listObjects: async () => [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
  return { provider, reads };
}

/** A process over the ledger in `dataDir`: its store and service, and the resources a drive over `provider` takes. */
function boot(dataDir: string, provider: DatabaseProvider) {
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const resources = {
    connection,
    capabilities,
    labels: TABLE_LABELS,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker,
    artifacts,
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs, () => 10_000),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
  };
  return { store, service, resources };
}

function freshDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-read-allowance-"));
  dataDirs.push(dataDir);
  return dataDir;
}

async function startRun(service: AgentRunService) {
  const availability = workflowAvailability("agent", "investigation", connection.type);
  if (!availability.open) throw new Error("an investigation does not open on postgres");
  return service.start({
    mode: "agent",
    workflowType: "investigation",
    ...persistedRunFacts("agent", "investigation", availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "How many orders are there?",
  });
}

async function eventsOf(store: AgentRunStore, runId: string): Promise<readonly AgentRunEvent[]> {
  const view = await store.read(runId);
  if (!view) throw new Error(`run ${runId} has no ledger`);
  return view.record.events;
}

/** One agent-mode drive over `provider`: the events it recorded and the requests it sent the model. */
async function drive(
  provider: DatabaseProvider,
  turns: readonly ScriptedTurn[],
): Promise<{ readonly events: readonly AgentRunEvent[]; readonly turns: readonly Turn[] }> {
  // A cold process per drive, so each one takes its own grounding read.
  forgetHeldSnapshots();
  const { store, service, resources } = boot(freshDataDir(), provider);
  const run = await startRun(service);
  const script = scriptedModel(...turns, answersProse("No report."), answersProse("No report."));
  await runInvestigation(run.runId, {
    service,
    model: await modelOver(script.fetch),
    resources,
  }).catch(() => undefined);
  return { events: await eventsOf(store, run.runId), turns: script.turns };
}

const countOrders = (id: string): ScriptedTurn =>
  callsTool("run_read_query", { sql: MODEL_SQL, rationale: "count them" }, id);

describe("the run read allowance", () => {
  test("is the one allowance of its run: the grounding's catalog reads and the model's statement charge it alike", async () => {
    const { provider, reads } = billingProvider(() => 1);

    await drive(provider, [countOrders("call_1")]);

    const statement = reads.filter((read) => read.sql === MODEL_SQL);
    const grounding = reads.filter((read) => read.sql !== MODEL_SQL);
    expect(statement).toHaveLength(1);
    // The capture reads the catalog before the first turn, through the same read-only path.
    expect(grounding.length).toBeGreaterThan(0);
    const allowances = new Set(reads.map((read) => read.allowance));
    expect(allowances.size).toBe(1);
    const [allowance] = allowances;
    expect(allowance?.limit).toBe(AGENT_RUN_READ_ALLOWANCE);
    // The first read found it whole, and every read after found it one lower: each charge landed on it.
    expect(reads.map((read) => read.remainingBefore)).toEqual(
      reads.map((_read, index) => AGENT_RUN_READ_ALLOWANCE - index),
    );
    expect(allowance?.remaining()).toBe(AGENT_RUN_READ_ALLOWANCE - reads.length);
  });

  test("bounds each run on its own, though both read through one cached provider", async () => {
    const { provider, reads } = billingProvider(() => 3);

    await drive(provider, [countOrders("call_1")]);
    const firstRunReads = reads.length;
    await drive(provider, [countOrders("call_1")]);

    const first = reads.slice(0, firstRunReads);
    const second = reads.slice(firstRunReads);
    expect(second.length).toBeGreaterThan(0);
    const [firstAllowance] = new Set(first.map((read) => read.allowance));
    const secondAllowances = new Set(second.map((read) => read.allowance));
    expect(secondAllowances.size).toBe(1);
    const [secondAllowance] = secondAllowances;
    expect(secondAllowance).not.toBe(firstAllowance);
    // The second run starts whole, whatever the first spent on the same provider.
    expect(second[0]?.remainingBefore).toBe(AGENT_RUN_READ_ALLOWANCE);
    expect(firstAllowance?.remaining()).toBe(AGENT_RUN_READ_ALLOWANCE - 3 * first.length);
    expect(secondAllowance?.remaining()).toBe(AGENT_RUN_READ_ALLOWANCE - 3 * second.length);
  });

  test("refuses a read past what is left, tells the model in the refusal's own sentence, and the run goes on", async () => {
    // The grounding spends one read per catalog statement; the model's statement asks for the whole allowance, which
    // the grounding has already drawn on, so it is refused before it is sent.
    const { provider, reads } = billingProvider((sql) => (sql === MODEL_SQL ? AGENT_RUN_READ_ALLOWANCE : 1));

    const { turns, events } = await drive(provider, [countOrders("call_1")]);

    const [refused] = reads.filter((read) => read.sql === MODEL_SQL);
    expect(refused?.allowance?.remaining()).toBe(refused?.remainingBefore);
    // Settled as a statement the model can repair, the way a result past the row budget is: the refusal is in the
    // next request the model is sent, and the run asks it again rather than ending.
    const next = turns[1];
    if (next === undefined) throw new Error("the run ended at the refusal instead of asking the model again");
    expect(promptText(next)).toContain(READ_ALLOWANCE_PREFIX);
    expect(events.some((event) => event.kind === "tool-refused")).toBe(true);
    // This server refused it, before anything was sent, so it is said in the server's own voice: never fenced as
    // the database's error, and followed by what to do about it.
    expect(promptText(next)).not.toContain("database error; operation");
    expect(promptText(next)).toContain("refused by this server before it was sent; the database was not asked");
  });

  test("is the run's, not the drive's: a resumed drive starts from what the ledger says the run spent", async () => {
    const { provider, reads } = billingProvider(() => 5);
    forgetHeldSnapshots();
    const dataDir = freshDataDir();
    const first = boot(dataDir, provider);
    const run = await startRun(first.service);
    // The process dies after the statement settles: the model is asked again and nothing answers.
    const dying = scriptedModel(countOrders("call_1"));
    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(dying.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow();
    const firstSpend = 5 * reads.length;
    const settled = (await eventsOf(first.store, run.runId)).find((event) => event.kind === "tool-completed");
    // The settled step records what the whole run had spent by then, the grounding's catalog reads included.
    expect(settled).toMatchObject({ readsSpent: firstSpend });

    const firstDriveReads = reads.length;
    const second = boot(dataDir, provider);
    const resumed = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT count(*) FROM orders WHERE id > 0", rationale: "count again" }, "c2"),
      answersProse("No report."),
      answersProse("No report."),
    );
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    }).catch(() => undefined);

    const secondDrive = reads.slice(firstDriveReads);
    expect(secondDrive.length).toBeGreaterThan(0);
    // Not a fresh allowance: the resumed drive found only what the first one left.
    expect(secondDrive[0]?.remainingBefore).toBe(AGENT_RUN_READ_ALLOWANCE - firstSpend);
    expect(secondDrive[0]?.allowance?.limit).toBe(AGENT_RUN_READ_ALLOWANCE);
    const recorded = (await eventsOf(second.store, run.runId)).filter((event) => event.kind === "tool-completed");
    expect(recorded.at(-1)).toMatchObject({ readsSpent: 5 * reads.length });
  });

  test("a run on an engine that charges nothing records no spend", async () => {
    const { provider } = billingProvider(() => 0);
    const { events } = await drive(provider, [countOrders("call_1")]);
    const settled = events.filter((event) => event.kind === "tool-completed" || event.kind === "tool-refused");
    expect(settled.length).toBeGreaterThan(0);
    for (const event of settled) expect(event).not.toHaveProperty("readsSpent");
  });
});
