import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import {
  connectionIdentity,
  fingerprintInventory,
  forgetHeldSnapshots,
  holdSnapshotForConnection,
} from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_RUN_READ_ALLOWANCE, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type {
  AgentContextSnapshot,
  AgentInventory,
  AgentRunEvent,
  AgentRunMode,
  AgentRunWorkflowType,
  AgentToolRefusal,
} from "@/lib/agent/types";
import { UNTRUSTED_PROVIDER_TEXT_BEGIN, UNTRUSTED_PROVIDER_TEXT_END } from "@/lib/agent/untrusted-content";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { RefusedBeforeSendError } from "@/lib/db/errors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { secretForms } from "@/lib/db/utils/server-text";
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

/** A provider fence's sentence, deliberately without a closing full stop. */
const FENCE_SENTENCE = "Read-only execution refused the statement before sending it: not-a-real-fence";

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

async function startRun(
  service: AgentRunService,
  mode: AgentRunMode = "agent",
  workflowType: AgentRunWorkflowType = "investigation",
) {
  const availability = workflowAvailability(mode, workflowType, connection.type);
  if (!availability.open) throw new Error(`a ${mode} ${workflowType} run does not open on postgres`);
  return service.start({
    mode,
    workflowType,
    ...persistedRunFacts(mode, workflowType, availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "How many orders are there?",
  });
}

/**
 * An inventory snapshot as a drive recorded it before the walk scrubbed its provider sentences: every sentence on it
 * carries `password` raw.
 */
function rawSnapshot(password: string): AgentContextSnapshot {
  const inventory = {
    objects: [
      {
        path: ["public", "orders"],
        name: "orders",
        kind: "table",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: { unavailable: `index read refused for ${password}` },
        foreignKeys: [],
      },
    ],
    kinds: [
      { id: "table", role: "relation", label: "Table", labelPlural: "Tables", sampledFrom: `a walk as ${password}` },
      { id: "view", role: "relation", label: "View", labelPlural: "Views", unavailable: `denied for ${password}` },
    ],
    truncated: { limit: 1, reason: `bounded for ${password}` },
    unreadContainers: {
      count: 1,
      label: "Schema",
      labelPlural: "Schemas",
      read: ["public"],
      unlistedParents: [{ path: "archive", label: "Schema", reason: `could not list as ${password}` }],
    },
  } as AgentInventory;
  const fingerprint = fingerprintInventory(inventory);
  return { ...inventory, connectionId: connection.id, fingerprint, capturedAtMs: 1 };
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
    // The allowance's own advice, not the advice for any other statement refused before it was sent: the repair is a
    // smaller read.
    expect(promptText(next)).toContain("ask for a smaller one that fits what is left");
  });

  test("a refusal asked again is answered from the ledger as refused before it was sent, not as the database's", async () => {
    const { provider } = billingProvider((sql) => (sql === MODEL_SQL ? AGENT_RUN_READ_ALLOWANCE : 1));

    const { turns, events } = await drive(provider, [countOrders("call_1"), countOrders("call_2")]);

    expect(events.filter((event) => event.kind === "tool-refused")).toMatchObject([
      { refusal: { class: "database-error", sent: false } },
    ]);
    const replay = turns[2];
    if (replay === undefined) throw new Error("the run ended before the repeated call was answered");
    expect(promptText(replay)).toContain("This exact call was already made in this run.");
    expect(promptText(replay)).toContain(
      "(run_read_query) was refused before it was sent, so the database never saw it:",
    );
    expect(promptText(replay)).not.toContain("failed at the database");
  });

  test("a provider's refusal asked again is fenced as the provider's text, naming it", async () => {
    // The provider's sentence is its own text, not this server's: a replay fences it as the provider's, naming the
    // provider bundled with Studio, and this server's advice follows outside the fence.
    const { provider } = billingProvider(() => 1);
    const read = provider.queryReadOnly?.bind(provider);
    if (read === undefined) throw new Error("the double reads nothing");
    const fenced = {
      ...provider,
      queryReadOnly: async (sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult> => {
        if (sql === MODEL_SQL) throw new RefusedBeforeSendError(FENCE_SENTENCE, "postgres", sql);
        return read(sql, budget);
      },
    } as DatabaseProvider;

    const { turns, events } = await drive(fenced, [countOrders("call_1"), countOrders("call_2")]);

    expect(events.filter((event) => event.kind === "tool-refused")).toMatchObject([
      { refusal: { class: "database-error", sent: false, refusedBy: "provider" } },
    ]);
    const replay = turns[2];
    if (replay === undefined) throw new Error("the run ended before the repeated call was answered");
    const text = promptText(replay);
    expect(text).toContain(
      "(run_read_query) was refused before it was sent, by the PostgreSQL provider, bundled with Studio, so the database never saw it:",
    );
    expect(text).toContain(
      "[UNTRUSTED PROVIDER TEXT: refusal before sending; written by the PostgreSQL provider, bundled with Studio; operation run_read_query;",
    );
    expect(text).toContain(`${UNTRUSTED_PROVIDER_TEXT_BEGIN}\n${FENCE_SENTENCE}\n${UNTRUSTED_PROVIDER_TEXT_END}`);
    expect(text).toContain(
      `${UNTRUSTED_PROVIDER_TEXT_END}\nDraft a statement that does not do what the refusal names.`,
    );
  });

  /** A run whose ledger holds `refusal`, written as a ledger from before this server recorded who refused. */
  async function resumedOver(refusal: Record<string, unknown>, runConnection: DatabaseConnection = connection) {
    const { provider } = billingProvider(() => 1);
    forgetHeldSnapshots();
    const { store, service, resources } = boot(freshDataDir(), provider);
    const run = await startRun(service);
    await store.appendEvent(run.runId, { kind: "tool-invoked", atMs: 1, stepId: "step_old", tool: "run_read_query" });
    await store.appendEvent(run.runId, {
      kind: "tool-refused",
      atMs: 2,
      stepId: "step_old",
      refusal: refusal as AgentToolRefusal,
    });
    const script = scriptedModel(answersProse("No report."), answersProse("No report."));
    await runInvestigation(run.runId, {
      service,
      model: await modelOver(script.fetch),
      resources: { ...resources, connection: runConnection },
    }).catch(() => undefined);
    const first = script.turns[0];
    if (first === undefined) throw new Error("the resumed run never asked the model");
    return promptText(first);
  }

  test("a refusal recorded before refusedBy existed is read as the provider's text on a resumed run", async () => {
    const text = await resumedOver({
      class: "database-error",
      statementFingerprint: "fp_old",
      message: FENCE_SENTENCE,
      sent: false,
    });

    expect(text).toContain("Step step_old (run_read_query) was refused before it was sent, by the PostgreSQL provider");
    expect(text).toContain(`${UNTRUSTED_PROVIDER_TEXT_BEGIN}\n${FENCE_SENTENCE}\n${UNTRUSTED_PROVIDER_TEXT_END}`);
  });

  test("a refusal Studio recorded is restated in Studio's voice on a resumed run", async () => {
    const sentence = `${READ_ALLOWANCE_PREFIX}: this run cannot pay for that read`;
    const text = await resumedOver({
      class: "database-error",
      statementFingerprint: "fp_old",
      message: sentence,
      sent: false,
      refusedBy: "studio",
    });

    expect(text).toContain(
      `Step step_old (run_read_query) was refused before it was sent, so the database never saw it: ${sentence}. Draft a statement`,
    );
    expect(text).not.toContain(UNTRUSTED_PROVIDER_TEXT_BEGIN);
  });

  test("a resumed run withholds a credential an older ledger recorded", async () => {
    const password = crypto.randomUUID();
    const credentialed: DatabaseConnection = { ...connection, password };
    for (const refusal of [
      { class: "database-error", statementFingerprint: "fp_old", message: `refused for ${password}`, sent: false },
      { class: "database-error", statementFingerprint: "fp_old", message: `login failed: ${password}` },
    ]) {
      const text = await resumedOver(refusal, credentialed);
      expect(text).toContain(PROVIDER_TEXT_WITHHELD);
      for (const form of secretForms([password])) expect(text).not.toContain(form);
    }
  });

  test("a resumed run withholds a credential an older ledger's inventory snapshot recorded in a provider's sentence", async () => {
    const password = crypto.randomUUID();
    const credentialed: DatabaseConnection = { ...connection, password };
    const { provider } = billingProvider(() => 0);
    forgetHeldSnapshots();
    const { store, service, resources } = boot(freshDataDir(), provider);
    const run = await startRun(service);
    const snapshot = rawSnapshot(password);
    await store.appendEvent(run.runId, {
      kind: "context-captured",
      atMs: 1,
      fingerprint: snapshot.fingerprint,
      tableCount: 1,
      snapshot,
    });
    const script = scriptedModel(answersProse("No report."), answersProse("No report."));
    await runInvestigation(run.runId, {
      service,
      model: await modelOver(script.fetch),
      resources: { ...resources, connection: credentialed },
    }).catch(() => undefined);
    const first = script.turns[0];
    if (first === undefined) throw new Error("the resumed run never asked the model");
    const text = promptText(first);

    expect(text).toContain("orders");
    expect(text).toContain(PROVIDER_TEXT_WITHHELD);
    for (const form of secretForms([password])) expect(text).not.toContain(form);
  });

  for (const workflowType of ["investigation", "operations"] as const) {
    for (const source of ["recorded", "held"] as const) {
      test(`a plan run of the ${workflowType} workflow grounded on a ${source} snapshot withholds a credential its provider sentences carry raw`, async () => {
        const password = crypto.randomUUID();
        const credentialed: DatabaseConnection = { ...connection, password };
        const { provider } = billingProvider(() => 0);
        forgetHeldSnapshots();
        const { store, service, resources } = boot(freshDataDir(), provider);
        const run = await startRun(service, "planning", workflowType);
        const snapshot = rawSnapshot(password);
        if (source === "recorded") {
          await store.appendEvent(run.runId, {
            kind: "context-captured",
            atMs: 1,
            fingerprint: snapshot.fingerprint,
            tableCount: 1,
            snapshot,
          });
        } else {
          holdSnapshotForConnection(snapshot, connectionIdentity(credentialed));
        }
        const script = scriptedModel(answersProse("No plan."), answersProse("No plan."));
        await runInvestigation(run.runId, {
          service,
          model: await modelOver(script.fetch),
          resources: { ...resources, connection: credentialed },
        }).catch(() => undefined);
        const first = script.turns[0];
        if (first === undefined) throw new Error(`the plan run over a ${source} snapshot never asked the model`);
        const text = promptText(first);

        expect(text).toContain("orders");
        expect(text).toContain(PROVIDER_TEXT_WITHHELD);
        for (const form of secretForms([password])) expect(text).not.toContain(form);
        forgetHeldSnapshots();
      });
    }
  }

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
