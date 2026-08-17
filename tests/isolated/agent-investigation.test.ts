import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { streamText, tool } from "ai";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_REPORT_RESERVE_TURNS, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import {
  AGENT_CITATION_RULE,
  AGENT_REPORT_RESERVE_NOTICE,
  type AgentToolResources,
  runInvestigation,
} from "@/lib/agent/investigation";
import type { AgentModel } from "@/lib/agent/model-adapter";
import { resolveAgentProviderAdapter } from "@/lib/agent/provider-registry";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService, AgentRunServiceError } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import { AGENT_TOOL_DEFINITIONS } from "@/lib/agent/tools";
import type { AgentRunActor, AgentRunEvent, AgentRunRecord, AgentRunWorkflowType } from "@/lib/agent/types";
import { UNTRUSTED_CONTENT_BEGIN } from "@/lib/agent/untrusted-content";
import { QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { LLMAuthError } from "@/lib/llm/types";
import type { DatabaseConnection, DatabaseType, QueryResult } from "@/lib/types";
import {
  type Turn,
  answersProse,
  callsTool,
  correlationIdIn,
  modelOver,
  promptText,
  reportOn,
  scriptedModel,
  unansweredCall,
} from "./fixtures/agent-scripted-model";
import { chatNeverAnswers, chatToolCallStream, endpointError } from "./fixtures/agent-transport";

/**
 * The investigation workflow (#329 T7b): the loop that turns one objective into a
 * run, and — the milestone criterion — survives the process that was driving it
 * dying mid-flight.
 *
 * Three things about the setup are deliberate rather than convenient:
 *
 *  - The ledger is a REAL `@workflow/world-local` over a real temporary
 *    directory, and a "restart" is a genuinely second set of in-memory objects
 *    (store, service, budget tracker, artifact store, deadline, repair ledger)
 *    opened over the same files. Nothing is carried across by reference, so a
 *    resumed run can only know what the previous process wrote down.
 *  - The model is the REAL ratified provider package driven over a scripted
 *    `fetch`, as in `agent-capability-probe.test.ts`. A stubbed model would prove
 *    that the loop calls what it calls; it could not prove that the transcript a
 *    resumed run rebuilds is one an SDK will actually send.
 *  - The database is the real M1 pipeline down to a spy `queryReadOnly`. That spy
 *    is the instrument for "no tool execution is performed twice": after a restart
 *    it must not be reached again for work the ledger already records.
 *
 * Shares Group 0f for the same reason the other agent model tests do: it maps SDK
 * failures onto the REAL `@/lib/llm` error classes, which `tests/api/ai/*.test.ts`
 * replaces process-wide with stubs.
 */

const ACTOR: AgentRunActor = { sessionId: "sess_1", role: "admin" };

const CONNECTION: DatabaseConnection = {
  id: "conn_1",
  name: "Orders",
  type: "postgres",
  createdAt: new Date(0),
};

const CAPABILITIES: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

const OBJECTIVE = "Why is the orders report slow?";

function queryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 9, ...overrides };
}

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-investigation-"));
  dataDirs.push(dir);
  return dir;
}

/**
 * One process's view of a run: everything that lives in memory, over a data
 * directory that does not. Calling this twice on the same directory is what a
 * restart is in this suite.
 */
interface Boot {
  readonly service: AgentRunService;
  readonly store: AgentRunStore;
  readonly resources: AgentToolResources;
  readonly queryReadOnly: ReturnType<typeof mock>;
  readonly acquireProvider: ReturnType<typeof mock>;
}

interface BootOptions {
  /** What the database does with each statement it is handed. */
  readonly answer?: (sql: string) => Promise<QueryResult>;
  /** Milliseconds the run's clock has jumped by the time the deadline is next read. */
  readonly spentMs?: number;
  /**
   * Fails the provider acquisition — a reach that dies before the statement is
   * sent. Called once per acquisition and may return nothing, so a fixture can let
   * the drive's context capture succeed and take the pool away afterwards.
   */
  readonly acquireFails?: () => Error | undefined;
}

function boot(dataDir: string, options: BootOptions = {}): Boot {
  const answer = options.answer ?? (async () => queryResult());
  const queryReadOnly = mock((sql: string) => answer(sql));
  const provider = { queryReadOnly } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => {
    const failure = options.acquireFails?.();
    if (failure) throw failure;
    return provider;
  });

  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 32 });
  // The deadline's clock reads its start, and every later reading is that start
  // plus `spentMs`. At the default of zero it never advances, so the deadline is
  // never the reason anything fails — except in the tests where that is the point.
  const startedAtMs = 10_000;
  let started = false;
  const deadlineClock = (): number => {
    if (!started) {
      started = true;
      return startedAtMs;
    }
    return startedAtMs + (options.spentMs ?? 0);
  };

  return {
    service: new AgentRunService({ store, resources: { tracker, artifacts } }),
    store,
    resources: {
      connection: CONNECTION,
      capabilities: CAPABILITIES,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope("conn_1"),
      tracker,
      artifacts,
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs, deadlineClock),
      repairs: new AgentRepairLedger(),
      acquireProvider,
    },
    queryReadOnly,
    acquireProvider,
  };
}

// ─── ledger helpers ─────────────────────────────────────────────────────────

async function eventsOf(store: AgentRunStore, runId: string): Promise<readonly AgentRunEvent[]> {
  const view = await store.read(runId);
  if (!view) throw new Error(`run ${runId} has no ledger`);
  return view.record.events;
}

const kindsOf = (events: readonly AgentRunEvent[]): string[] => events.map((event) => event.kind);

/**
 * Catalog reads one drive makes for its context snapshot before the model's first
 * turn (#329 T8): the column, relation and index inventories, on this suite's
 * PostgreSQL connection.
 *
 * The T8 block at the end of this file asserts the number and the statements
 * directly. Everywhere else it is the OFFSET between "statements this run sent" and
 * "statements the model asked for", which is why it is a named constant rather than
 * a literal 3 sprinkled through the assertions — an agent-mode drive that reaches a
 * turn has always paid it.
 */
const CONTEXT_READS = 3;

/** The three statements one context capture sends, in order. */
const CATALOG_READS = ["information_schema.columns", "information_schema.table_constraints", "pg_index"] as const;

/**
 * The statements the MODEL's tool calls sent, after the drive's own catalog reads.
 *
 * The prefix is VERIFIED rather than assumed: a bare `slice(3)` would also return
 * an empty list when the run sent nothing at all, so `expect(…).toEqual([])` would
 * pass for a run that never reached the database and for one that made exactly the
 * expected calls alike. `captured` is 0 for a drive that reused its run's recorded
 * inventory and therefore read no catalog.
 */
const modelStatements = (spy: ReturnType<typeof mock>, captured = CONTEXT_READS): string[] => {
  const all = spy.mock.calls.map((call) => String(call[0]));
  const prefix = all.slice(0, captured);
  const expected = CATALOG_READS.slice(0, captured);
  if (prefix.length !== captured || !expected.every((needle, index) => prefix[index]?.includes(needle))) {
    throw new Error(`expected ${captured} catalog read(s) first, got: ${prefix.join(" | ") || "(none)"}`);
  }
  return all.slice(captured);
};

/**
 * The statements a drive sent that are NOT the server's own grounding reads.
 *
 * The instrument for plan mode's actual promise since the grounding design of
 * 2026-08-15: the mode may read this connection's catalog, and may run nothing else.
 * Written as "which statements do not belong here" rather than as a count, because a
 * count passes just as happily for a run that sent something entirely different.
 *
 * Every needle is a fragment only a server-composed catalog or statistics read
 * contains, on this suite's PostgreSQL connection.
 */
const GROUNDING_READ_MARKERS = [
  "information_schema.columns",
  "information_schema.table_constraints",
  "pg_index",
  "pg_stats",
] as const;

const userStatements = (spy: ReturnType<typeof mock>): string[] =>
  spy.mock.calls
    .map((call) => String(call[0]))
    .filter((sql) => !GROUNDING_READ_MARKERS.some((marker) => sql.includes(marker)));

/** The system prompt of one turn, which is where a run's rules are stated. */
const rulesOfTurn = (turn: Turn): string => {
  const messages = (turn.body.messages ?? []) as { role?: string; content?: unknown }[];
  const system = messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
};

function invocationsOf(events: readonly AgentRunEvent[]): string[] {
  return events.filter((event) => event.kind === "tool-invoked").map((event) => event.stepId);
}

async function startRun(
  boot: Boot,
  mode: "agent" | "planning" = "agent",
  workflowType?: AgentRunWorkflowType,
  autoExecute?: boolean,
): Promise<AgentRunRecord> {
  return boot.service.start({
    mode,
    actor: ACTOR,
    connectionId: "conn_1",
    objective: OBJECTIVE,
    ...(workflowType === undefined ? {} : { workflowType }),
    ...(autoExecute === undefined ? {} : { autoExecute }),
  });
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  // The inventories a process holds outlive a run by design (#384), so every test
  // here starts from the cold process. Without this a planning test would be
  // grounded or not depending on which agent test ran before it.
  forgetHeldSnapshots();
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── the whole arc ──────────────────────────────────────────────────────────

describe("a fresh run drives the investigation arc", () => {
  test("drafts a statement, reads, and reports with evidence", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "size the table" }),
      reportOn(),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("report-composed");
    expect(result.turns).toBe(2);
    expect(kindsOf(await eventsOf(b.store, run.runId))).toEqual([
      "run-started",
      // The drive's own schema capture, before the model was asked anything.
      "context-captured",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      "report-composed",
      // No closing statement: this model reports and says nothing after it, and an
      // empty entry would record that it spoke.
      "run-finished",
    ]);
    expect(b.queryReadOnly).toHaveBeenCalledTimes(CONTEXT_READS + 1);
  });

  test("the drafted statement and its rationale are recorded before the invocation", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "size the table" }),
      reportOn(),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const events = await eventsOf(b.store, run.runId);
    const draft = events.find((event) => event.kind === "statement-drafted");
    expect(draft).toMatchObject({ sql: "SELECT id FROM orders", rationale: "size the table" });
    // The draft precedes the invocation it describes, and they share a step id.
    expect(draft && "stepId" in draft && draft.stepId).toBe(invocationsOf(events)[0]);
  });

  test("the report's claims reach the ledger with their evidence", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders" }),
      reportOn("Orders has one row."),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const composed = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "report-composed");
    expect(composed).toBeDefined();
    expect(composed && "claims" in composed && composed.claims[0]?.claim).toBe("Orders has one row.");
    expect(composed && "claims" in composed && composed.claims[0]?.evidence[0]).toMatchObject({ source: "artifact" });
  });

  test("the catalog and plan tools reach the database through the same audited path", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("inspect_schema", { schema: "public" }),
      callsTool("inspect_plan", { sql: "SELECT id FROM orders" }, "call_2"),
      answersProse("that is enough"),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("succeeded");
    expect(b.queryReadOnly).toHaveBeenCalledTimes(CONTEXT_READS + 2);
    // The server composed both statements: the model supplied a selector and an
    // inner statement, never the catalog SQL or the EXPLAIN wrapper.
    expect(modelStatements(b.queryReadOnly)[0]).toContain("information_schema");
    expect(modelStatements(b.queryReadOnly)[1]).toMatch(/^EXPLAIN/);

    // What each tool drafts follows from what the MODEL authored, not from whether
    // the tool reaches the database. `inspect_schema` takes only a selector, so
    // there is no model statement to record; `inspect_plan`'s inner statement is
    // one the model genuinely wrote (`tools.ts` says so where it explains why
    // `shape` advice applies to it), so it is drafted before the invocation that
    // carries it. Asserted as the whole ordered ledger so neither half can drift
    // into the other unnoticed.
    const events = await eventsOf(b.store, run.runId);
    expect(kindsOf(events)).toEqual([
      "run-started",
      "context-captured",
      "tool-invoked",
      "tool-completed",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      // This run ends on prose rather than a report, and that prose is now the only
      // thing it leaves behind — which is exactly the case that used to vanish.
      "closing-statement",
      "run-finished",
    ]);
    const draft = events.find((event) => event.kind === "statement-drafted");
    // The plan tool declares no `rationale`, so the draft records that plainly
    // rather than inventing one.
    expect(draft).toMatchObject({ sql: "SELECT id FROM orders", rationale: "(none given)" });
    expect(draft && "stepId" in draft && draft.stepId).toBe(invocationsOf(events)[1]);
  });

  test("arguments the tool schema refuses become a typed answer, not a throw", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(callsTool("run_read_query", { sql: 42 }), answersProse("understood"));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("succeeded");
    // The context capture's reads and nothing else: the refused arguments never
    // became a statement.
    expect(modelStatements(b.queryReadOnly)).toEqual([]);
    const events = await eventsOf(b.store, run.runId);
    // Nothing was drafted (there is no statement), the invocation is recorded, and
    // it settles nothing — so that exact call may not be sent again.
    expect(kindsOf(events)).not.toContain("statement-drafted");
    expect(invocationsOf(events)).toHaveLength(1);
    expect(kindsOf(events)).not.toContain("tool-completed");
    expect(script.turns[1]?.transcript).toContain("arguments");
  });

  test("a call refused before the database is not described as an interrupted one", async () => {
    // Both refusals settle nothing in the ledger, so a step refused in THIS drive is
    // indistinguishable by ledger shape from one inherited from a dead process. They
    // are not the same thing to a model: nothing was attempted here, and saying "its
    // outcome was never recorded, so whether it reached the database cannot be
    // known" of a call the server itself rejected would be false.
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: 42 }),
      callsTool("run_read_query", { sql: 42 }, "call_2"),
      answersProse("understood"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const answer = script.turns[2]?.transcript ?? "";
    expect(answer).toContain("refused before the database was reached");
    expect(answer).not.toContain("interrupted");
    expect(modelStatements(b.queryReadOnly)).toEqual([]);
  });

  test("a rejected argument list does not put two results in the transcript for one call", async () => {
    // On this path the SDK's own `response.messages` carries a `role:"tool"` result
    // for the call it could not parse, and the loop appends its own answer for the
    // same id. Sending both back is a transcript a real endpoint refuses with a 400,
    // so one malformed argument list would wedge every later turn of the run — and
    // no other assertion here would notice, because the fixture accepts any body.
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(callsTool("run_read_query", { sql: 42 }), answersProse("understood"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const sent = (script.turns[1]?.body.messages ?? []) as { role: string; tool_call_id?: string }[];
    expect(sent.filter((message) => message.tool_call_id === "call_1")).toHaveLength(1);
    // The assistant turn that asked for it is still there: this trims the duplicate
    // result, not the model's own message.
    expect(sent.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  test("the model is offered exactly the four read-class tools", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("nothing to do"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // Read without an assertion that the turn happened: a run that asked the model
    // nothing at all would otherwise throw here rather than fail an assertion.
    const declared = script.turns[0]?.body.tools as { function: { name: string } }[] | undefined;
    expect(declared?.map((t) => t.function.name).sort()).toEqual([
      "compose_report",
      "inspect_plan",
      "inspect_schema",
      "run_read_query",
    ]);
  });

  test("the objective and the untrusted-content rule are both stated to the model", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("ok"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const messages = script.turns[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain(UNTRUSTED_CONTENT_BEGIN);
    // The objective is the user's own words and is stated as itself; the packed
    // schema context follows it, fenced, so the last message is no longer the
    // objective and asserting on position would pin the wrong thing.
    expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toContain(
      OBJECTIVE,
    );
  });
});

/*
  #350. Both places that told the model to cite said only that a claim must cite.
  Neither said what a citation IS, and two live runs spent five of seven turns
  guessing at it — one of them sending `SELECT 1` purely to keep thinking — while
  holding the correlation id they needed.

  These assertions are about the PROMPT, which is unusual here and is the point: a
  scripted model already knows the contract and can never be confused by it, so no
  behavioural test in this suite can see this defect. What CAN be pinned mechanically
  is that the shape appears in each of the three places a model looks — the rules it
  is opened with, the moment an id changes hands, and the summary a resumed run is
  given — and that what appears there is the shape the parser accepts.
*/
describe("the model is told what a citation IS, not only that it must cite (#350)", () => {
  /** Every literal evidence object in a prompt, as the model would lift one out. */
  const offeredObjects = (text: string): { source: string; correlationId?: string; fingerprint?: string }[] =>
    [...text.matchAll(/\{"source":"[a-z-]+","[A-Za-z]+":"[^"]*"\}/g)].map((match) => JSON.parse(match[0]));

  /** The rules the run was opened with, on their own — not the messages beside them. */
  const rulesOf = (turn: Turn): string => {
    const messages = (turn.body.messages ?? []) as { role?: string; content?: unknown }[];
    const system = messages.find((message) => message.role === "system");
    return typeof system?.content === "string" ? system.content : "";
  };

  test("the run's rules carry both arms of the evidence contract", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("ok"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(
      offeredObjects(rulesOf(script.turns[0] as Turn))
        .map((object) => object.source)
        .sort(),
    ).toEqual(["artifact", "context-snapshot"]);
  });

  test("the snapshot's own fingerprint is offered as a citation when it is captured", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("ok"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const captured = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "context-captured");
    if (captured?.kind !== "context-captured") throw new Error("this drive captured no snapshot");
    // Not the placeholder from the rules: the run's OWN fingerprint, ready to copy.
    expect(offeredObjects(promptText(script.turns[0] as Turn))).toContainEqual({
      source: "context-snapshot",
      fingerprint: captured.fingerprint,
    });
  });

  test("a completed read offers its own id in the shape a claim takes", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "size it" }),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const completed = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "tool-completed");
    if (completed?.kind !== "tool-completed") throw new Error("this drive completed no tool call");
    // The SECOND turn is where the tool's answer reached the model.
    expect(offeredObjects(promptText(script.turns[1] as Turn))).toContainEqual({
      source: "artifact",
      correlationId: completed.artifact.correlationId,
    });
  });

  test("a resumed run is offered the same shapes for what it already established", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    // One completed read, then the driving process stops answering.
    const died = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "size it" }));
    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(died.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow();

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("ok"));
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    const events = await eventsOf(second.store, run.runId);
    const completed = events.find((event) => event.kind === "tool-completed");
    const captured = events.find((event) => event.kind === "context-captured");
    if (completed?.kind !== "tool-completed" || captured?.kind !== "context-captured") {
      throw new Error("the resumed run has no prior progress to be told about");
    }

    const offered = offeredObjects(promptText(resumed.turns[0] as Turn));
    expect(offered).toContainEqual({ source: "artifact", correlationId: completed.artifact.correlationId });
    expect(offered).toContainEqual({ source: "context-snapshot", fingerprint: captured.fingerprint });
  });

  test("planning mode is not told to cite anything, because it has nothing to cite", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("a plan"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(offeredObjects(promptText(script.turns[0] as Turn))).toEqual([]);
  });
});

// ─── planning mode ──────────────────────────────────────────────────────────

/*
  THE INVARIANT THIS BLOCK PINS MOVED, deliberately, on 2026-08-15.

  It used to be "planning mode performs zero database operations", and every test in
  it asserted that no provider was ever acquired. `docs/superpowers/specs/
  2026-08-15-plan-mode-sql-generator-design.md` changed that on the owner's decision,
  for a reason a live run made concrete: a plan run could only be about a real
  database when an AGENT run had already read one on the same connection in the same
  process, so the safe mode's usefulness was conditional on having used the unsafe
  one. Asked about a real six-table database, plan mode named none of them.

  What the product actually sells is narrower than "reaches nothing", and it is what
  these tests assert now:

   - a planning run runs NO STATEMENT OF THE USER'S. It reads the catalog — which is
     what the sidebar does on every connect — and nothing else.
   - the MODEL stays toolless. Grounding is the server's work, not a capability
     handed to the model, so the tool set on every planning turn is still empty.
   - nothing is written, and every statement it drafts is handed to the user to run.

  `userStatements` below is the instrument: it fails loudly on any statement that is
  not one of the server's own grounding reads, so a future change that let a planning
  run send something of the model's cannot pass by asserting a count.
*/
describe("planning mode runs no statement of the user's", () => {
  test("the model is handed no tools, only the server's catalog reads are sent, and the prose is returned", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("First ", "look at the index."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(script.turns[0]?.body.tools).toBeUndefined();
    expect(userStatements(b.queryReadOnly)).toEqual([]);
    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("model-stopped");
    expect(result.text).toBe("First look at the index.");
  });

  /*
    The one workflow a plan run is NOT grounded for, and the one place that is a
    decision rather than a shortfall. An operations objective is about what the engine
    reports about itself — sessions, locks, waits, configuration — so a catalog read
    would spend the run's statements on an inventory the plan has no use for. The
    grounding design of 2026-08-15 lists `operations` as the row whose plan deliverable
    stays prose for exactly this reason.

    Its sentence is its own rather than the agent mode's, because
    `OPERATIONS_CONTEXT_NOTE` tells the model to take readings with `inspect_operations`
    and a planning run has no tools at all: naming one it does not have is the #350
    failure. Both halves are asserted, since the note being merely PRESENT would pass
    just as well with the wrong one of the two.
  */
  test("an operations plan is given its own note, reads no catalog, and is told of no tool", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning", "operations");
    const script = scriptedModel(answersProse("I would read the wait events."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(script.turns[0]?.transcript).toContain(
      "an operations objective is about what the engine reports about ITSELF",
    );
    expect(script.turns[0]?.transcript).not.toContain("inspect_operations");
    expect(script.turns[0]?.body.tools).toBeUndefined();
    // Not grounded, and not partially grounded either: no statement of any kind was
    // sent, so neither the catalog nor the statistics were read.
    expect(b.queryReadOnly).not.toHaveBeenCalled();
    expect(b.acquireProvider).not.toHaveBeenCalled();
    expect(kindsOf(await eventsOf(b.store, run.runId))).not.toContain("context-captured");
    // And the rules say it has seen nothing, rather than pointing at an inventory
    // that was never read.
    expect(rulesOfTurn(script.turns[0] as Turn)).toContain("No schema inventory is available to this run");
    expect(result.status).toBe("succeeded");
  });

  /*
    The prose was already RETURNED to the caller, and the test above asserts exactly
    that — which is how a planning run could pass its tests while producing nothing a
    user ever sees. A run's ledger is the only thing that outlives the drive, so a
    plan the ledger does not carry is a plan that was discarded. Nine live runs on
    2026-08-12 produced zero visible output for this reason.
  */
  test("the plan reaches the ledger, not just the caller", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("Start with ", "the salary index."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const events = await eventsOf(b.store, run.runId);
    const closing = events.find((event) => event.kind === "closing-statement");
    expect(closing).toBeDefined();
    expect(closing).toMatchObject({ text: "Start with the salary index." });
    // The record a resumed reader folds says the same thing the drive returned.
    expect(closing && "text" in closing ? closing.text : null).toBe(result.text);
  });

  test("the ledger records how the loop ended, not only that it did", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("a plan"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const finished = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "run-finished");
    expect(finished).toMatchObject({ status: "succeeded", stopReason: "model-stopped" });
  });

  test("a run that says nothing writes no empty closing statement", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse(""));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const events = await eventsOf(b.store, run.runId);
    expect(events.some((event) => event.kind === "closing-statement")).toBe(false);
  });

  test("a planning run still has a cancellation checkpoint between turns", async () => {
    // Planning mode reaches no tool, so `runStep` — where T7a put the checkpoint —
    // is never called. Without a checkpoint in the loop itself a planning run could
    // not be stopped at all, so this asserts the loop has its own.
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(async () => {
      await b.service.cancel(run.runId, ACTOR);
      // A tool call keeps the loop going to a second iteration; in planning mode it
      // is not offered, so it is answered in prose and reaches nothing.
      return chatToolCallStream("run_read_query", JSON.stringify({ sql: "SELECT 1" }));
    });

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    expect(result.turns).toBe(1);
    // The refused tool call reached nothing: the only statements this run sent are
    // the server's own grounding reads, taken before the first turn.
    expect(userStatements(b.queryReadOnly)).toEqual([]);
  });

  test("a tool the run was never offered is refused without reaching the database", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(callsTool("run_read_query", { sql: "SELECT 1" }), answersProse("understood"));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // Nothing of the model's reached a database, and no step was ever invoked: the
    // grounding reads are the SERVER's, so they settle no step and enter no ledger
    // as a tool call.
    expect(userStatements(b.queryReadOnly)).toEqual([]);
    expect(invocationsOf(await eventsOf(b.store, run.runId))).toEqual([]);
    expect(script.turns[1]?.transcript).toContain("run_read_query");
    expect(result.status).toBe("succeeded");
  });

  /*
    #384, and the grounding design that followed it.

    The defect that produced this block was measured on 2026-08-15. Asked how it
    would assess a real six-table database, a plan run answered "without direct
    access to the live environment … I cannot execute live queries or run
    diagnostics directly" and named not one table. Nothing was wrong with the
    sentence — the run genuinely had nothing — and that is the point: a plan that
    would read identically against any database in the world is not a plan about
    this one.

    #384 answered it by handing a plan run the inventory an agent run on the same
    connection had already read. That path survives here as the FREE FAST PATH — it
    costs no capture, and these tests still assert the "somebody else read this"
    wording it makes true — but it is no longer the only way a plan run is grounded.
    The cold process is covered in the T8 block at the end of this file, where a plan
    run reads its own.
  */
  describe("a plan run reasons about THIS database when the process has already read it", () => {
    /** The system prompt, which is where a planning run's rules are stated. */
    const rulesOf = (turn: Turn): string => {
      const messages = (turn.body.messages ?? []) as { role?: string; content?: unknown }[];
      const system = messages.find((message) => message.role === "system");
      return typeof system?.content === "string" ? system.content : "";
    };

    /** A catalog that answers with two related tables, so the inventory has real names. */
    const catalog = async (sql: string): Promise<QueryResult> => {
      if (sql.includes("information_schema.columns")) {
        return queryResult({
          rows: [
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "id",
              data_type: "integer",
              is_nullable: "NO",
            },
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "customer_id",
              data_type: "integer",
              is_nullable: "NO",
            },
            {
              table_schema: "public",
              table_name: "customers",
              column_name: "id",
              data_type: "integer",
              is_nullable: "NO",
            },
          ],
          fields: ["table_schema", "table_name", "column_name", "data_type", "is_nullable"],
          rowCount: 3,
        });
      }
      if (sql.includes("table_constraints")) {
        return queryResult({
          rows: [
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "customer_id",
              referenced_schema: "public",
              referenced_table: "customers",
              referenced_column: "id",
            },
          ],
          fields: ["table_schema", "table_name", "column_name", "referenced_table", "referenced_column"],
          rowCount: 1,
        });
      }
      return queryResult({ rows: [], fields: [], rowCount: 0 });
    };

    /** One agent run, which is what puts this connection's inventory in the process. */
    const readTheCatalogOnce = async (b: Boot): Promise<void> => {
      const run = await startRun(b, "agent");
      const script = scriptedModel(answersProse("understood"));
      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });
    };

    test("it is shown the real tables and their relations, fenced, and still sends nothing", async () => {
      const reader = boot(freshDataDir(), { answer: catalog });
      await readTheCatalogOnce(reader);

      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "planning");
      const script = scriptedModel(answersProse("a plan"));

      const result = await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      const transcript = script.turns[0]?.transcript ?? "";
      expect(transcript).toContain("orders");
      expect(transcript).toContain("customers");
      // The relations block, so a plan can name a join and not only a table.
      expect(transcript).toContain("customer_id");
      // Database-derived text reaches the model fenced here exactly as in agent
      // mode: table names are writable by whoever can write to the database.
      expect(transcript).toContain(UNTRUSTED_CONTENT_BEGIN);
      // And the mode's own bar is untouched: the model has no tools, and nothing of
      // the user's or the model's was sent.
      expect(script.turns[0]?.body.tools).toBeUndefined();
      expect(userStatements(b.queryReadOnly)).toEqual([]);
      // The fast path really is free of the CAPTURE: the inventory came from what
      // this process had already read, so no catalog was re-read and no capture was
      // recorded. (The estimated statistics are read on every grounded path, which
      // is why this asserts on the ledger rather than on the statement count.)
      expect(kindsOf(await eventsOf(b.store, run.runId))).not.toContain("context-captured");
      expect(b.queryReadOnly.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining("pg_stats") as unknown as string,
      ]);
      expect(result.status).toBe("succeeded");
    });

    /*
      The prompt half, which is not optional (#350): a rule the model is not told is
      a rule live runs fail. An inventory handed over and never mentioned in the
      rules is a window full of schema and a plan that ignores it.
    */
    test("it is told the inventory is somebody else's reading, and what it may not conclude from it", async () => {
      const reader = boot(freshDataDir(), { answer: catalog });
      await readTheCatalogOnce(reader);

      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "planning");
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      const rules = rulesOf(script.turns[0] as Turn);
      expect(rules).toContain("A schema inventory for this database is in this conversation");
      expect(rules).toContain("read by an EARLIER run on this connection rather than by this one");
      // What the sentence may NOT claim any more: this run did read the estimated
      // statistics beside the inventory, so "this run has sent nothing to any
      // database" — true while the hold was a plan run's only source (#384) — would
      // now be a false self-description. The promise that survives is the narrower,
      // true one.
      expect(rules).not.toContain("sent nothing to any database");
      expect(rules).toContain("no statement of the user's was run");
      expect(rules).toContain("Name the real tables");
      // What the numbers beside it are NOT. The inventory says what exists; the
      // statistics block says roughly how much of it there is, and a model told the
      // second without being told what an estimate is worth quotes one as a fact.
      expect(rules).toContain("every number there is the engine's own estimate");
      expect(rules).toContain("never one you may treat as empty or small");
      // The workflow framing still applies to a plan of one.
      expect(rules).toContain("You have no tools in this mode");
      // The preface the inventory arrives under says the same thing in the messages.
      expect(script.turns[0]?.transcript).toContain("so this run did not have to read it again");
      expect(script.turns[0]?.transcript).not.toContain("This run has read nothing");
    });

    /*
      The honest-limits half of the design (item 6): grounding is served for the
      dialects `CATALOG_COMPOSERS` covers — PostgreSQL and SQLite — and on any other
      engine the run is ungrounded and must KNOW it. This used to be reachable by
      simply not having read the catalog; since a plan run reads its own, the engine
      is what makes it reachable, and it is the case that still ships.
    */
    test("a run on an engine this server cannot ground is told so rather than left to invent a schema", async () => {
      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "planning");
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: { ...b.resources, connection: { ...CONNECTION, type: "mongodb" } },
      });

      const rules = rulesOf(script.turns[0] as Turn);
      expect(rules).toContain("No schema inventory is available to this run");
      expect(rules).toContain("invent no table or column names");
      expect(rules).not.toContain("A schema inventory for this database is in this conversation");
      // Nothing was shown to it either — no packed inventory reaches a run that has
      // none, so there is nothing for it to mistake for one. (The fence markers
      // themselves are in every run's rules, which is why the header is what this
      // looks for.)
      expect(script.turns[0]?.transcript).not.toContain("table(s) read at epoch");
      // It is told WHICH engine, in the server's own voice and without naming a tool
      // it does not have (#350).
      expect(script.turns[0]?.transcript).toContain("on this mongodb connection");
      expect(script.turns[0]?.transcript).not.toContain("inspect_schema");
      expect(b.acquireProvider).not.toHaveBeenCalled();
    });

    /*
      An inventory is held for the connection it describes, and a plan run reads the
      connection its own record names. This is the same boundary the loop already
      enforces on the resources it is driven with, seen from the other side.
    */
    test("an inventory read for another connection does not ground this one", async () => {
      const reader = boot(freshDataDir(), { answer: catalog });
      await readTheCatalogOnce(reader);

      // A second connection with a schema of its own. The run on it must be grounded
      // in ITS catalog: the held reading for `conn_1` is not merely unpreferred here,
      // it must not appear at all.
      const otherCatalog = async (sql: string): Promise<QueryResult> =>
        sql.includes("information_schema.columns")
          ? queryResult({
              rows: [
                {
                  table_schema: "public",
                  table_name: "invoices",
                  column_name: "id",
                  data_type: "integer",
                  is_nullable: "NO",
                },
              ],
              fields: ["table_schema", "table_name", "column_name", "data_type", "is_nullable"],
              rowCount: 1,
            })
          : queryResult({ rows: [], fields: [], rowCount: 0 });

      const other = boot(freshDataDir(), { answer: otherCatalog });
      const run = await other.service.start({
        mode: "planning",
        actor: ACTOR,
        connectionId: "conn_2",
        objective: OBJECTIVE,
      });
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: other.service,
        model: await modelOver(script.fetch),
        resources: {
          ...other.resources,
          connection: { ...CONNECTION, id: "conn_2" },
          scope: createTargetScope("conn_2"),
        },
      });

      // Grounded, and grounded in its own database: the reading it was given is one
      // it took itself, and the other connection's tables are nowhere in its window.
      expect(rulesOf(script.turns[0] as Turn)).toContain(
        "A schema inventory for this database is in this conversation",
      );
      expect(script.turns[0]?.transcript).toContain("invoices");
      expect(script.turns[0]?.transcript).not.toContain("customers");
    });
  });

  /*
    Item 3 of `docs/superpowers/specs/2026-08-15-plan-mode-sql-generator-design.md`:
    what a plan run is asked to PRODUCE.

    Grounding a plan run fixes what it knows; it does not fix what it hands back. The
    contract it was given until 2026-08-15 — "answer with a plan in prose: what you
    would inspect, in what order, and what each step would establish" — asks for a
    lecture, and a lecture is what the live run of that date produced against a real
    six-table database. Grounding it without rewriting this would have produced the
    same numbered inspection plan with real table names in it.

    So the deliverable is now ONE runnable statement, or an explicit refusal, and both
    halves are asserted here because the failure mode is the same either way: a run
    that answers with generic advice as though advice were an answer.
  */
  describe("a plan run is asked for a statement, not for a lecture", () => {
    /** Every workflow the contract knows, total by typecheck rather than by hand. */
    const EVERY_WORKFLOW = Object.keys({
      investigation: 0,
      "query-optimization": 0,
      "database-assessment": 0,
      operations: 0,
      "data-analysis": 0,
    } satisfies Record<AgentRunWorkflowType, number>) as AgentRunWorkflowType[];

    /** The rules of a plan run of one workflow, on this suite's PostgreSQL connection. */
    const planRulesFor = async (workflowType: AgentRunWorkflowType): Promise<string> => {
      const b = boot(freshDataDir());
      const run = await startRun(b, "planning", workflowType);
      const script = scriptedModel(answersProse("a plan"));
      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });
      return rulesOfTurn(script.turns[0] as Turn);
    };

    test("a grounded plan is asked for one runnable statement, fenced and tagged with this engine", async () => {
      const rules = await planRulesFor("investigation");

      expect(rules).toContain("Produce ONE runnable statement");
      // The deliverable of THIS workflow, not a generic "some SQL": the record is what
      // makes a plan of an optimization ask for a rewrite and a plan of an
      // investigation ask for the answer.
      expect(rules).toContain("the statement that answers the question");
      // The fence and its tag are stated exactly, because the UI reads the statement
      // back out of the fence (#389) and a tag it does not recognise costs the user
      // the editor hand-off. `postgres` is the canonical type-id, which is the tag
      // `rich-text.tsx` accepts.
      expect(rules).toContain("fenced block tagged `postgres`");
      // Rationale AFTER the statement, so the deliverable is the first thing in the
      // answer rather than the conclusion of an essay.
      expect(rules).toContain("Put the rationale AFTER the statement");
      expect(rules).toContain("Use no table name and no column name that is not in that inventory");
      // The honest limit of item 6: an inventory records what EXISTS, not what this
      // user's role may select from, so a validated statement is not a statement that
      // will run.
      expect(rules).toContain("not a statement that is certain to run");
      // And the refusal path is stated on the grounded side too: an inventory that
      // does not reach the objective is the ordinary case, not an error.
      expect(rules).toContain("NO STATEMENT:");
    });

    test("an ungrounded plan is told to refuse with NO STATEMENT: rather than invent one", async () => {
      const b = boot(freshDataDir());
      const run = await startRun(b, "planning");
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        // The engine decides it: grounding is served for the dialects
        // `CATALOG_COMPOSERS` covers, and on anything else the run has no inventory
        // at all.
        resources: { ...b.resources, connection: { ...CONNECTION, type: "mongodb" } },
      });

      const rules = rulesOfTurn(script.turns[0] as Turn);
      expect(rules).toContain("No schema inventory is available to this run");
      expect(rules).toContain("invent no table or column names");
      expect(rules).toContain("begin a line with `NO STATEMENT:`");
      // The defect this whole change exists to remove, named in the rules so the model
      // cannot mistake generic advice for a permitted answer.
      expect(rules).toContain("A general inspection plan is not an answer here");
      // It is NOT asked for a statement it cannot write: telling a run to produce one
      // and to refuse in the same breath is how a model splits the difference and
      // invents a schema.
      expect(rules).not.toContain("Produce ONE runnable statement");
    });

    test("an operations plan is not given the statement contract at all", async () => {
      const rules = await planRulesFor("operations");

      // The one row of the design's deliverable table that is prose, and it is a
      // decision rather than a shortfall: an operations objective is about what the
      // engine reports about itself, so there is no schema to write a statement
      // against and no statement to write.
      expect(rules).toContain("There is no statement to write here");
      expect(rules).not.toContain("Produce ONE runnable statement");
      expect(rules).not.toContain("NO STATEMENT:");
      // And it still knows it has no inventory, which is what stops it inventing one.
      expect(rules).toContain("No schema inventory is available to this run");
    });

    /*
      The record is TOTAL over `AgentRunWorkflowType`, the same way
      `WORKFLOW_OBJECTIVES` and `WORKFLOW_TOOL_RULES` are, so a workflow added to the
      union stops `investigation.ts` compiling until someone decides what a plan of it
      produces. The compiler enforces that a key exists; this asserts that the key is
      worth having — that every workflow's plan rules actually name a deliverable
      rather than falling through to a shared sentence.
    */
    test("every workflow's plan names what that plan is to produce", async () => {
      const expected: Readonly<Record<AgentRunWorkflowType, string>> = {
        investigation: "the statement that answers the question",
        "query-optimization": "the rewritten statement",
        "database-assessment": "the statement that measures the quality concern",
        "data-analysis": "the statement that produces the answer",
        // Prose, by decision. Its deliverable sentence is what it says instead.
        operations: "the readings you would take",
      };

      for (const workflowType of EVERY_WORKFLOW) {
        expect(await planRulesFor(workflowType)).toContain(expected[workflowType]);
      }
    });
  });

  /*
    Item 5 of the same design: the statement a plan run drafts becomes a FACT on the
    ledger rather than something the browser parses back out of markdown.

    It mattered because the ledger is the only thing that outlives the drive. #389's
    "Apply to editor" control reads SQL out of a fence in the browser — it works when
    the model fences its SQL and silently offers nothing when it does not — so plan
    mode's entire deliverable was recorded nowhere and could be checked by nothing
    (`docs/BACKLOG.md` B44).

    What is asserted here is the wiring and, as carefully, its limits: an unknown
    table is RECORDED and the statement is still offered, a write is MARKED and still
    offered, and a run with no inventory says it checked nothing rather than reporting
    that everything checked out. The extraction and validation rules themselves are
    pinned in `tests/unit/lib/agent/plan-statement.test.ts`.
  */
  describe("the statement a plan run drafts becomes a ledger fact", () => {
    /** A catalog with two real tables, so "unknown" means something in these runs. */
    const catalog = async (sql: string): Promise<QueryResult> =>
      sql.includes("information_schema.columns")
        ? queryResult({
            rows: [
              { table_schema: "public", table_name: "film", column_name: "title", data_type: "text" },
              { table_schema: "public", table_name: "actor", column_name: "name", data_type: "text" },
            ],
            fields: ["table_schema", "table_name", "column_name", "data_type"],
            rowCount: 2,
          })
        : queryResult({ rows: [], fields: [], rowCount: 0 });

    /*
      The tag is a parameter because it is a CLAIM: a block tagged for one engine is not
      a deliverable on a connection of another, and the reader rejects it rather than
      relabelling it (#396 review). The default matches the default connection; a test
      on a different engine passes a tag that does not contradict it.
    */
    const fenced = (sql: string, tag = "postgres"): string =>
      ["Here is the statement.", "", `\`\`\`${tag}`, sql, "```"].join("\n");

    /** The drafted-statement entry of a run's ledger, or undefined when it wrote none. */
    const draftedIn = (events: readonly AgentRunEvent[]): AgentRunEvent | undefined =>
      events.find((event) => event.kind === "plan-statement-drafted");

    const planWith = async (
      closing: string,
      options: { readonly workflowType?: AgentRunWorkflowType; readonly type?: DatabaseType } = {},
    ): Promise<readonly AgentRunEvent[]> => {
      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "planning", options.workflowType);
      const script = scriptedModel(answersProse(closing));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources:
          options.type === undefined
            ? b.resources
            : { ...b.resources, connection: { ...CONNECTION, type: options.type } },
      });

      return eventsOf(b.store, run.runId);
    };

    test("a statement fenced in the closing prose is recorded with the engine it was written for", async () => {
      const events = await planWith(fenced("SELECT title FROM film;"));

      expect(draftedIn(events)).toMatchObject({
        kind: "plan-statement-drafted",
        sql: "SELECT title FROM film;",
        dialect: "postgres",
        readOnly: true,
        identifiers: { kind: "checked", unknownTables: [] },
      });
      // Beside the prose, not instead of it: the closing statement is still the run's
      // own output and still what the rail renders.
      expect(kindsOf(events)).toContain("closing-statement");
    });

    /*
      The case the design names: a hallucinated table must not reach the user's editor
      as though it were sound. It is recorded rather than dropped, because the run did
      draft it and hiding that would leave a user wondering why plan mode said nothing.
    */
    test("a table the inventory does not hold is recorded on the statement, which is still kept", async () => {
      const drafted = draftedIn(await planWith(fenced("SELECT * FROM film JOIN payments ON true")));

      expect(drafted).toMatchObject({
        readOnly: true,
        identifiers: { kind: "checked", unknownTables: ["payments"] },
      });
    });

    /*
      The owner's decision, wired: a write is MARKED, not blocked. What the mark is for
      is the rail — "Apply to editor" must never silently hand a user a DELETE — and
      the run itself still executed nothing.
    */
    test("a write is marked with the guard's own reason rather than dropped", async () => {
      const drafted = draftedIn(await planWith(fenced("DELETE FROM film")));

      expect(drafted).toMatchObject({ readOnly: false, guardViolation: "NON_READ_STATEMENT" });
    });

    /*
      An ungrounded run checked no identifier, and its entry says so. Recording an
      empty unknown-table list would claim every table this statement names exists in
      an inventory this run never read — the precision this repository's standing
      defect class keeps claiming.
    */
    test("a run with no inventory records that it checked nothing, not that nothing was wrong", async () => {
      // Tagged `sql`, which names no engine: a `postgres` tag here would be the model
      // writing for one database while connected to another, and is refused as such.
      const drafted = draftedIn(await planWith(fenced("SELECT * FROM anything", "sql"), { type: "mongodb" }));

      expect(drafted).toMatchObject({ dialect: "mongodb", identifiers: { kind: "no-inventory" } });
    });

    /*
      The tag is the model saying which engine it wrote for, and the recorder stamps the
      event with the CONNECTION's engine. Taking a block that names another one would
      file the model's MySQL as PostgreSQL and report the run as answered (#396 review).
    */
    test("a block tagged for another engine is not recorded as this run's statement", async () => {
      const events = await planWith(fenced("SELECT * FROM film", "mysql"));

      expect(draftedIn(events)).toBeUndefined();
    });

    test("an explicit refusal drafts no statement, and is not recorded as one", async () => {
      const events = await planWith("NO STATEMENT: nothing in the inventory records payments.");

      expect(draftedIn(events)).toBeUndefined();
      expect(kindsOf(events)).toContain("closing-statement");
    });

    test("prose with no fenced block records no statement", async () => {
      expect(draftedIn(await planWith("I would begin by inspecting the indexes."))).toBeUndefined();
    });

    /*
      The one workflow whose plan deliverable is prose. A fenced block there is
      illustration rather than the run's deliverable — the contract never asked it for
      a statement — so recording one would put a statement on the ledger that no
      contract asked for. #389's per-block control still offers it in the rail.
    */
    test("an operations plan records no statement, whatever it fences", async () => {
      expect(draftedIn(await planWith(fenced("SELECT 1"), { workflowType: "operations" }))).toBeUndefined();
    });

    test("an agent run's closing prose is not a plan statement, however it is fenced", async () => {
      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "agent");
      const script = scriptedModel(answersProse(fenced("SELECT title FROM film")));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      // An agent run drafts its statements through a tool, where each one is already a
      // `statement-drafted` entry tied to the step that ran it. A second reading of its
      // prose would record a statement the run never asked to run.
      expect(draftedIn(await eventsOf(b.store, run.runId))).toBeUndefined();
    });
  });

  test("no workflow may present an answer yet, so an agent run calling it is told there is no such tool", async () => {
    // `present_answer` exists in the tool record and is in no workflow's set, and
    // this is that decision seen from the run loop: the model is answered in prose,
    // no step is invoked, and no database is reached. The workflow that offers the
    // tool is what makes it callable, and it does not exist yet.
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent");
    const script = scriptedModel(
      callsTool("present_answer", { artifact: "corr_1", presentation: { kind: "table" } }),
      answersProse("understood"),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(invocationsOf(await eventsOf(b.store, run.runId))).toEqual([]);
    expect(script.turns[1]?.transcript).toContain("present_answer");
    expect(result.status).toBe("succeeded");
  });
});

// ─── durability across a restart ────────────────────────────────────────────

describe("a run survives the process driving it dying", () => {
  test("a tool call already in the ledger is replayed, never performed again", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    const dying = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders" }));

    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(dying.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow();
    expect(first.queryReadOnly).toHaveBeenCalledTimes(CONTEXT_READS + 1);

    // A genuinely new process: new store, new service, new budgets, new artifacts.
    // The resumed tool-call id deliberately DIFFERS from the dead process's: a real
    // provider mints a fresh one per call, so reusing `call_1` here would let a step
    // id derived from the tool-call id pass this test while breaking the guarantee.
    const second = boot(dataDir);
    const resumed = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders" }, "call_resumed"),
      reportOn(),
    );

    const result = await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    expect(result.status).toBe("succeeded");
    // THE milestone assertion: the statement was executed once, across both
    // processes, and the ledger holds exactly one invocation of that step. The
    // resumed drive reaches the database for NOTHING — not even its schema context,
    // which it re-derives from the inventory the ledger carries.
    expect(second.queryReadOnly).not.toHaveBeenCalled();
    const events = await eventsOf(second.store, run.runId);
    expect(invocationsOf(events)).toHaveLength(1);
    expect(kindsOf(events).filter((kind) => kind === "statement-drafted")).toHaveLength(1);
    expect(kindsOf(events).filter((kind) => kind === "tool-completed")).toHaveLength(1);
  });

  test("a statement whose rationale the model reworded is still the same step", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    const dying = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "size the table" }),
    );

    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(dying.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow();
    expect(first.queryReadOnly).toHaveBeenCalledTimes(CONTEXT_READS + 1);

    // The resumed model asks for the SAME statement and, as models do, explains it
    // differently the second time. The rationale reaches the engine in no form and
    // is narrated on its own, so it cannot be part of the step's identity: if it
    // were, this read would be performed a second time.
    const second = boot(dataDir);
    const resumed = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "confirm the size" }, "call_resumed"),
      reportOn(),
    );

    const result = await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    expect(result.status).toBe("succeeded");
    expect(second.queryReadOnly).not.toHaveBeenCalled();
    const events = await eventsOf(second.store, run.runId);
    expect(invocationsOf(events)).toHaveLength(1);
    expect(kindsOf(events).filter((kind) => kind === "tool-completed")).toHaveLength(1);
    // The second rationale is not narrated either: the step was already known.
    expect(kindsOf(events).filter((kind) => kind === "statement-drafted")).toHaveLength(1);
  });

  test("a cancellation recorded against a run whose loop died is honoured on resume", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    await first.service.markRunning(run.runId);
    // The loop is gone; the stop request outlives it in the ledger.
    await first.service.cancel(run.runId, ACTOR);

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("I would look at the index."));
    const result = await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    // The model is never asked: a run the user stopped does not get another turn.
    expect(resumed.turns).toHaveLength(0);
    expect(second.queryReadOnly).not.toHaveBeenCalled();
  });

  test("what the dead process established is described to the resumed one", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    const dying = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders" }));
    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(dying.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow();

    const second = boot(dataDir);
    const resumed = scriptedModel(reportOn());
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    // The resumed run is told what happened before it, including the correlation
    // id it needs to cite — the rows themselves were never persisted.
    const transcript = resumed.turns[0]?.transcript ?? "";
    expect(transcript).toContain("SELECT id FROM orders");
    expect(transcript).toContain("run_read_query");
    // The rows are gone with the process that read them, and the resumed run is
    // handed references and counts rather than a result it cannot have.
    expect(transcript).not.toContain('{\\"id\\":1}');
    expect(transcript).toContain("The rows themselves are not delivered again");
  });

  test("a step invoked with no recorded outcome is never repeated", async () => {
    const dataDir = freshDataDir();
    // The pool goes away AFTER the drive's context capture: this test is about a
    // step the model asked for whose outcome was never recorded, so the capture has
    // to get far enough for the model to be asked anything at all.
    let acquisitions = 0;
    const first = boot(dataDir, {
      acquireFails: () => (++acquisitions > CONTEXT_READS ? new Error("the pool went away") : undefined),
    });
    const run = await startRun(first);
    const dying = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders" }));

    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(dying.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow("the pool went away");
    const afterDeath = await eventsOf(first.store, run.runId);
    expect(invocationsOf(afterDeath)).toHaveLength(1);
    expect(kindsOf(afterDeath)).not.toContain("tool-completed");

    const second = boot(dataDir);
    const resumed = scriptedModel(
      // A fresh tool-call id, as a real provider would mint: the step must be
      // recognised by what it does, not by the id the model happened to reuse.
      callsTool("run_read_query", { sql: "SELECT id FROM orders" }, "call_resumed"),
      callsTool("run_read_query", { sql: "SELECT id FROM orders LIMIT 5" }, "call_2"),
      reportOn(),
    );
    const result = await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    expect(result.status).toBe("succeeded");
    // The repeated call was refused as indeterminate, so only the NEW statement ran.
    // The resumed drive read no catalog: its run recorded an inventory already.
    expect(modelStatements(second.queryReadOnly, 0)).toHaveLength(1);
    expect(modelStatements(second.queryReadOnly, 0)[0]).toContain("LIMIT 5");
    const events = await eventsOf(second.store, run.runId);
    expect(invocationsOf(events).filter((stepId) => stepId === invocationsOf(afterDeath)[0])).toHaveLength(1);
  });
});

// ─── repair ─────────────────────────────────────────────────────────────────

describe("a failing statement is repaired, not repeated", () => {
  test("the engine's own words reach the model fenced, and a different statement succeeds", async () => {
    const b = boot(freshDataDir(), {
      answer: async (sql) => {
        if (sql.includes("odrers")) throw new QueryError('relation "odrers" does not exist', "postgres");
        return queryResult();
      },
    });
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM odrers" }),
      callsTool("run_read_query", { sql: "SELECT id FROM orders" }, "call_2"),
      reportOn(),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("succeeded");
    const events = await eventsOf(b.store, run.runId);
    expect(kindsOf(events).filter((kind) => kind === "tool-refused")).toHaveLength(1);
    expect(kindsOf(events).filter((kind) => kind === "tool-completed")).toHaveLength(1);
    // The failure reached the model, fenced as untrusted database content.
    expect(script.turns[1]?.transcript).toContain("odrers");
    expect(script.turns[1]?.transcript).toContain(UNTRUSTED_CONTENT_BEGIN);
  });

  test("the same statement asked for twice is replayed instead of run again", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders" }),
      callsTool("run_read_query", { sql: "SELECT id FROM orders" }, "call_2"),
      reportOn(),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(modelStatements(b.queryReadOnly)).toHaveLength(1);
    expect(invocationsOf(await eventsOf(b.store, run.runId))).toHaveLength(1);
  });
});

// ─── cancellation ───────────────────────────────────────────────────────────

describe("cancellation is honoured at the next checkpoint", () => {
  test("a stop asked for while the model was thinking ends the run before the statement", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(async () => {
      // Recorded while the model "answers": the loop's next checkpoint is the step.
      await b.service.cancel(run.runId, ACTOR);
      return chatToolCallStream("run_read_query", JSON.stringify({ sql: "SELECT id FROM orders" }));
    });

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    // The context capture ran (the stop was recorded after it, while the model was
    // answering); the model's own statement never reached the database.
    expect(modelStatements(b.queryReadOnly)).toEqual([]);
    expect(kindsOf(await eventsOf(b.store, run.runId))).toContain("run-finished");
  });
});

// ─── bounds ─────────────────────────────────────────────────────────────────

describe("the run loop is bounded", () => {
  test("a model that never stops calling tools ends the run at the turn limit", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT 1" }),
      callsTool("run_read_query", { sql: "SELECT 2" }, "call_2"),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      maxTurns: 2,
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("turn-limit");
    expect(result.turns).toBe(2);
  });

  /**
   * With no ceiling passed in, the one that binds is the RUN'S OWN — read from its
   * persisted workflow, not from a module-level constant. Driven on `operations`
   * because it is the cheapest row to script to exhaustion; what is being asserted is
   * the source of the number, and the source is the same for every row.
   */
  test("the turn ceiling a caller does not pass comes from the run's own workflow", async () => {
    const ceiling = AGENT_WORKFLOW_BUDGETS.operations.maxModelTurns;
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "operations");
    // One more turn than the ceiling allows, so a loop that read a larger ceiling
    // would run past it rather than dying on an exhausted script.
    const script = scriptedModel(
      ...Array.from({ length: ceiling + 1 }, (_unused, index) =>
        callsTool("inspect_operations", { kind: "health" }, `call_${index}`),
      ),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.stopReason).toBe("turn-limit");
    expect(result.turns).toBe(ceiling);
  });

  /*
    A model call that never answers used to cost the whole run.

    Measured, not assumed: one planning run on 2026-08-12 ended at 300.0s — exactly
    the whole run deadline of the day — with a two-event ledger. The deadline did its job
    perfectly; the problem is that it was the ONLY bound on a single call, so one
    unanswered request spent a five-minute budget that was meant to cover a whole
    investigation, and the user watched a spinner for all of it.

    A turn ceiling makes the failure cheap and, more importantly, nameable: the run
    ends `model-timeout` rather than `deadline-exceeded`, because "this one request
    never came back" and "this run used its time" are different things to be told.
  */
  test("one unanswered model call ends the turn, not the whole run budget", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    // Never resolves: only the turn ceiling can end this.
    const script = scriptedModel(unansweredCall);

    const started = Date.now();
    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      turnTimeoutMs: 200,
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("model-timeout");
    // The run deadline is five minutes; this cost a fifth of a second.
    expect(Date.now() - started).toBeLessThan(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs);

    const finished = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "run-finished");
    expect(finished).toMatchObject({ status: "failed", stopReason: "model-timeout" });
  });

  test("a run that runs out of time is still reported as out of time, not as a slow call", async () => {
    // The turn ceiling must not relabel the run deadline: when less time remains than
    // a turn is allowed, the shorter bound is the run's own, and the reason follows it.
    const b = boot(freshDataDir(), { spentMs: AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs - 100 });
    const run = await startRun(b, "planning");
    const script = scriptedModel(unansweredCall);

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      turnTimeoutMs: 60_000,
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("deadline-exceeded");
  });

  test("a spent deadline ends the run without asking the model anything", async () => {
    const b = boot(freshDataDir(), { spentMs: AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs + 1_000 });
    const run = await startRun(b);
    const script = scriptedModel();

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(script.turns).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("deadline-exceeded");
  });
});

// ─── the reserved ending ────────────────────────────────────────────────────

/**
 * The report reserve (the data-analyst design, §1.5).
 *
 * A run that exhausts its turns ends `failed` / `turn-limit` with no report at all,
 * and the whole spend is lost — so the loop, which already knows both distances to
 * its ceilings, tells the model once when it has run out of room. What these tests
 * pin is that the message is a MESSAGE and not a rule change: it costs no statement,
 * no repair attempt, no deadline admission and no turn of its own, it does not lower
 * the citation bar, and a run that ignores it fails exactly as it did before.
 */
const noticesIn = (turn: Turn): number => promptText(turn).split(AGENT_REPORT_RESERVE_NOTICE).length - 1;

/** The messages the server put on the wire, as roles and verbatim content. */
const wireMessages = (turn: Turn): { role?: unknown; content?: unknown }[] =>
  (turn.body.messages ?? []) as { role?: unknown; content?: unknown }[];

describe("a run reserves its last turns for its report", () => {
  test("the turn reserve pushes the notice once, and no later turn pushes a second", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    // Four turns of tool calls against a ceiling of four: the reserve is crossed
    // before the third, and the fourth must not add another notice.
    const script = scriptedModel(
      ...Array.from({ length: 4 }, (_unused, index) =>
        callsTool("run_read_query", { sql: `SELECT ${index} FROM orders` }, `call_${index}`),
      ),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      maxTurns: 4,
    });

    expect(script.turns.map((turn) => noticesIn(turn))).toEqual([0, 0, 1, 1]);
    // Server-authored and verbatim: the notice reaches the model as its own user
    // message, exactly as this repository wrote it, with nothing spliced in.
    expect(wireMessages(script.turns[2] as Turn)).toContainEqual({
      role: "user",
      content: AGENT_REPORT_RESERVE_NOTICE,
    });
    // A run that is asked to report and does not still ends the way it always did.
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("turn-limit");
    expect(result.turns).toBe(4);
  });

  test("the millisecond reserve fires on its own, with turns to spare", async () => {
    // 15 s of run left against a 20 s reserve, and a turn ceiling nowhere near: the
    // only bound that can produce the notice here is the clock.
    const b = boot(freshDataDir(), { spentMs: AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs - 15_000 });
    const run = await startRun(b);
    const script = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders" }), reportOn());

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(noticesIn(script.turns[0] as Turn)).toBe(1);
    expect(AGENT_WORKFLOW_BUDGETS.investigation.maxModelTurns - script.turns.length).toBeGreaterThan(
      AGENT_REPORT_RESERVE_TURNS,
    );
    // And a run that takes the offer answers, rather than ending on the clock.
    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("report-composed");
  });

  test("a run that is asked to report and does not still ends on its own clock", async () => {
    // The turn ceiling's side of this is pinned above; this is the clock's side. An
    // agent run inside the reserve that spends its last turn on anything but a report
    // must still end the way it ended before the notice existed — the notice offers a
    // better ending, it does not change what happens when the offer is declined.
    const b = boot(freshDataDir(), { spentMs: AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs - 100 });
    const run = await startRun(b);
    const script = scriptedModel(unansweredCall);

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      turnTimeoutMs: 60_000,
    });

    expect(noticesIn(script.turns[0] as Turn)).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("deadline-exceeded");
  });

  test("a planning run is never told to call a tool it does not have", async () => {
    // One turn against a ceiling of one: an agent run in this position would be
    // inside its reserve before its first turn.
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("I would start with the orders table."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      maxTurns: 1,
    });

    expect(script.turns.map((turn) => noticesIn(turn))).toEqual([0]);
    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("model-stopped");
  });

  /**
   * "It costs nothing to reach" is asserted as a COMPARISON rather than as a set of
   * expected counts: the same script is driven twice, once inside the reserve and
   * once nowhere near it, and every meter the run is charged against must read the
   * same afterwards. Expected counts would pin what the drive spends; this pins that
   * the notice is not part of it.
   */
  test("the notice spends no statement, no repair attempt, no admission and no turn", async () => {
    const drive = async (maxTurns: number) => {
      const b = boot(freshDataDir());
      const run = await startRun(b);
      const admit = spyOn(b.resources.deadline, "admit");
      const script = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders" }), reportOn());
      const result = await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
        maxTurns,
      });
      return {
        turns: result.turns,
        stopReason: result.stopReason,
        notices: script.turns.map((turn) => noticesIn(turn)),
        admissions: admit.mock.calls.length,
        statements: b.resources.tracker.usage(run.runId).executedStatements,
        repairs: b.resources.repairs.attemptsUsed,
        reads: b.queryReadOnly.mock.calls.length,
      };
    };

    // A ceiling of three puts the second of two turns inside the reserve; the run's
    // own ceiling of 36 leaves the same two turns outside it.
    const reserved = await drive(3);
    const unreserved = await drive(AGENT_WORKFLOW_BUDGETS.investigation.maxModelTurns);

    expect(reserved.notices).toEqual([0, 1]);
    expect(unreserved.notices).toEqual([0, 0]);
    expect(reserved.turns).toBe(unreserved.turns);
    expect(reserved.stopReason).toBe(unreserved.stopReason);
    expect(reserved.admissions).toBe(unreserved.admissions);
    expect(reserved.statements).toBe(unreserved.statements);
    expect(reserved.repairs).toBe(unreserved.repairs);
    expect(reserved.reads).toBe(unreserved.reads);
  });

  /**
   * #350's lesson in the other direction: the notice must not become a second
   * wording of the citation contract, because the day the two disagree the model is
   * being told two different bars and the tool enforces one of them.
   */
  test("the notice restates the run's own citation rule rather than inventing one", async () => {
    expect(AGENT_REPORT_RESERVE_NOTICE).toContain("compose_report");
    expect(AGENT_REPORT_RESERVE_NOTICE).toContain(AGENT_CITATION_RULE);
    // Nothing a database wrote is in it, so it carries no fence and needs none.
    expect(AGENT_REPORT_RESERVE_NOTICE).not.toContain(UNTRUSTED_CONTENT_BEGIN);

    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("nothing to add"));
    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // The same sentence the run opened with: the rules the model was given carry it,
    // so the notice repeats the bar rather than restating it in other words.
    expect(JSON.stringify(script.turns[0]?.body)).toContain(AGENT_CITATION_RULE);
  });
});

// ─── failures the loop does not own ─────────────────────────────────────────

describe("a failure the loop cannot decide leaves the run resumable", () => {
  test("an endpoint refusal is mapped to this repository's error class and the run stays running", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(() => endpointError(401, "invalid api key"));

    await expect(
      runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      }),
    ).rejects.toBeInstanceOf(LLMAuthError);

    const view = await b.store.read(run.runId);
    expect(view?.record.status).toBe("running");
    expect(view?.terminal).toBe(false);
  });

  test("a model whose own stream fails is mapped, not left as an SDK error", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    // The one failure shape that arrives as a THROW rather than an error part —
    // the same stub `agent-capability-probe.test.ts` uses, for the same reason: an
    // unmapped SDK error carries the request body, and the request body is the prompt.
    const erroringModel: AgentModel = {
      provider: "custom",
      modelId: "stub",
      model: {
        specificationVersion: "v4",
        provider: "stub",
        modelId: "stub",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unused by this test");
        },
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.error(new Error("the model's own stream failed"));
            },
          }),
        }),
      } as unknown as AgentModel["model"],
    };

    await expect(
      runInvestigation(run.runId, { service: b.service, model: erroringModel, resources: b.resources }),
    ).rejects.toThrow("the model's own stream failed");
    expect((await b.store.read(run.runId))?.record.status).toBe("running");
  });

  test("a model that never answers is cut off by the run's own deadline", async () => {
    // 40ms of run left, and a response body that never completes: the only way
    // this call can end is the deadline-derived abort signal, which the fixture
    // honours the way a real transport does.
    const b = boot(freshDataDir(), { spentMs: AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs - 40 });
    const run = await startRun(b);
    const script = scriptedModel((turn) => chatNeverAnswers(turn.signal));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("deadline-exceeded");
  });

  test("a run cannot be driven against a connection other than the one it was opened on", async () => {
    // The record decides WHO a run acts as; it also records WHERE. Driving a run
    // with another connection's resources would execute against `conn_1` while the
    // ledger header kept claiming the run belonged to a different connection.
    const b = boot(freshDataDir());
    const run = await b.service.start({
      mode: "agent",
      actor: ACTOR,
      connectionId: "conn_9",
      objective: OBJECTIVE,
    });

    const error = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(scriptedModel().fetch),
      resources: b.resources,
    }).catch((thrown: unknown) => thrown);

    // The typed reason, not just the message: a bare `throw new Error` would satisfy
    // a text match while telling a caller nothing it can branch on.
    expect(error).toBeInstanceOf(AgentRunServiceError);
    expect((error as AgentRunServiceError).reasonCode).toBe("RUN_CONNECTION_MISMATCH");
    expect(b.acquireProvider).not.toHaveBeenCalled();
  });

  test("a run cannot be driven with a provider connection other than its own", async () => {
    // The scope satisfies the guard and the CONNECTION does not: `tools.ts` acquires
    // the provider from `connection` and reads the dialect off it, so binding only
    // the scope would let a caller pass the check and still reach another database.
    const b = boot(freshDataDir());
    const run = await startRun(b);

    const error = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(scriptedModel().fetch),
      resources: { ...b.resources, connection: { ...CONNECTION, id: "conn_other" } },
    }).catch((thrown: unknown) => thrown);

    expect((error as AgentRunServiceError).reasonCode).toBe("RUN_CONNECTION_MISMATCH");
    expect(b.acquireProvider).not.toHaveBeenCalled();
  });

  test("a run that has already ended cannot be driven again", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    await b.service.cancel(run.runId, ACTOR);

    await expect(
      runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(scriptedModel().fetch),
        resources: b.resources,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});

// ─── the report tool refuses invented evidence ──────────────────────────────

describe("a report may only cite what the run produced", () => {
  test("an invented correlation id is refused and no report is recorded", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("compose_report", {
        claims: [{ claim: "Everything is fine.", evidence: [{ source: "artifact", correlationId: "corr_invented" }] }],
      }),
      answersProse("I cannot support that claim."),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(kindsOf(await eventsOf(b.store, run.runId))).not.toContain("report-composed");
    expect(script.turns[1]?.transcript).toContain("evidence");
    expect(result.stopReason).toBe("model-stopped");
    expect(result.status).toBe("succeeded");
  });
});

// ─── replaying an arbitrary ledger ──────────────────────────────────────────

describe("prior progress is described from the ledger alone", () => {
  test("a settled step whose invocation is missing is described without naming a tool", async () => {
    // `appendEvent` enforces no lifecycle (recorded in `run-store.ts`), so a ledger
    // CAN hold an outcome with no invocation before it — corruption, not a race the
    // write-ahead ordering allows. The resumed run degrades to describing it without
    // a tool name rather than failing to start at all.
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    await first.service.markRunning(run.runId);
    await first.store.appendEvent(run.runId, {
      kind: "tool-refused",
      atMs: 1_700_000_000_000,
      stepId: "step_orphan",
      refusal: { class: "policy-denied", reasonCode: "TARGET_OUT_OF_SCOPE" },
    });

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("continuing"));
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    const transcript = resumed.turns[0]?.transcript ?? "";
    expect(transcript).toContain("step_orphan (a tool)");
    expect(transcript).toContain("TARGET_OUT_OF_SCOPE");
  });

  test("a run with narrated entries but no step is not told it was interrupted", async () => {
    // T8 captures a context snapshot at run start, so a run nothing has interrupted
    // can still reach its first turn with events in its ledger. Only a step is
    // evidence that a previous drive existed.
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    await first.service.markRunning(run.runId);
    await first.service.recordEvent(run.runId, {
      kind: "context-captured",
      fingerprint: "fp_1",
      tableCount: 2,
    });

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("continuing"));
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    const transcript = resumed.turns[0]?.transcript ?? "";
    expect(transcript).toContain("fp_1");
    expect(transcript).toContain("has already established");
    expect(transcript).not.toContain("was interrupted");
  });

  test("every event kind a ledger can hold is stated to a resumed run", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    await first.service.markRunning(run.runId);
    const at = 1_700_000_000_000;
    for (const event of [
      { kind: "context-captured", atMs: at, fingerprint: "fp_1", tableCount: 4 },
      { kind: "statement-drafted", atMs: at, stepId: "step_a", sql: "SELECT 1", rationale: "warm up" },
      { kind: "tool-invoked", atMs: at, stepId: "step_a", tool: "run_read_query", operationId: "sql.query.read" },
      {
        kind: "tool-completed",
        atMs: at,
        stepId: "step_a",
        artifact: {
          correlationId: "corr_a",
          runId: run.runId,
          operationId: "sql.query.read",
          summary: { rowCount: 7, columnNames: ["id"], elapsedMs: 3 },
        },
      },
      { kind: "tool-invoked", atMs: at, stepId: "step_b", tool: "inspect_plan", operationId: "sql.explain.estimate" },
      {
        kind: "tool-refused",
        atMs: at,
        stepId: "step_b",
        refusal: { class: "database-error", statementFingerprint: "fp_b", message: "syntax error at or near FROM" },
      },
      { kind: "tool-invoked", atMs: at, stepId: "step_c", tool: "inspect_schema", operationId: "sql.query.read" },
      {
        kind: "tool-refused",
        atMs: at,
        stepId: "step_c",
        refusal: { class: "policy-denied", reasonCode: "TARGET_OUT_OF_SCOPE" },
      },
      { kind: "tool-invoked", atMs: at, stepId: "step_d", tool: "inspect_plan", operationId: "sql.explain.estimate" },
      {
        kind: "tool-refused",
        atMs: at,
        stepId: "step_d",
        refusal: { class: "approval-required", operationId: "sql.explain.analyze" },
      },
      { kind: "tool-invoked", atMs: at, stepId: "step_e", tool: "run_read_query", operationId: "sql.query.read" },
      {
        kind: "report-composed",
        atMs: at,
        claims: [{ claim: "Orders is large.", evidence: [{ source: "artifact", correlationId: "corr_a" }] }],
      },
    ] as AgentRunEvent[]) {
      await first.store.appendEvent(run.runId, event);
    }

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("continuing"));
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    const transcript = resumed.turns[0]?.transcript ?? "";
    expect(transcript).toContain("fp_1");
    expect(transcript).toContain("SELECT 1");
    expect(transcript).toContain("corr_a");
    expect(transcript).toContain("TARGET_OUT_OF_SCOPE");
    expect(transcript).toContain("sql.explain.analyze");
    expect(transcript).toContain("step_c");
    // The engine's message is quoted as untrusted content, not as the server's voice.
    expect(transcript).toContain("syntax error at or near FROM");
    expect(transcript).toContain(UNTRUSTED_CONTENT_BEGIN);
  });
});

// ─── the run's schema context (#329 T8) ─────────────────────────────────────

describe("the run reads its schema context through the catalog tool", () => {
  /** The composed catalog statements, in the order the capture makes them. */
  const catalogStatements = (b: Boot): string[] =>
    b.queryReadOnly.mock.calls.slice(0, CONTEXT_READS).map((call) => String(call[0]));

  test("captures the inventory before the first turn, through the audited tool path", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("understood"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // Server-composed, every one of them: nothing here takes a statement from a
    // model, and each went through the same acquisition seam as any tool call.
    expect(catalogStatements(b)[0]).toContain("information_schema.columns");
    expect(catalogStatements(b)[1]).toContain("information_schema.table_constraints");
    expect(catalogStatements(b)[2]).toContain("pg_index");
    expect(b.acquireProvider).toHaveBeenCalledTimes(CONTEXT_READS);
    expect(kindsOf(await eventsOf(b.store, run.runId))[1]).toBe("context-captured");
  });

  test("the packed inventory reaches the model fenced, carrying the fingerprint a claim can cite", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("understood"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const captured = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "context-captured");
    const fingerprint = captured && "fingerprint" in captured ? captured.fingerprint : "";
    expect(fingerprint).toMatch(/^ctx_/);
    expect(script.turns[0]?.transcript).toContain(fingerprint);
    expect(script.turns[0]?.transcript).toContain(UNTRUSTED_CONTENT_BEGIN);
  });

  test("is read once per DRIVE, not once per turn", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT 1" }),
      callsTool("run_read_query", { sql: "SELECT 2" }, "call_2"),
      reportOn(),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.turns).toBe(3);
    // Three turns, one capture: a refresh the run has already made costs nothing.
    expect(b.queryReadOnly).toHaveBeenCalledTimes(CONTEXT_READS + 2);
    expect(kindsOf(await eventsOf(b.store, run.runId)).filter((kind) => kind === "context-captured")).toHaveLength(1);
  });

  /**
   * THE refresh assertion (#329 T8): a drive whose run already recorded an
   * inventory reaches no database for it at all. The ledger carries the inventory
   * itself, so the fingerprint is checked against the rows it summarises rather
   * than against a catalog read — which is the whole point, since a resumed run
   * starts every cost ceiling again (`docs/BACKLOG.md` B6) and would otherwise
   * spend three of its twenty statements re-reading rows it already has.
   */
  test("a drive whose run already recorded its inventory performs NO database operation for it", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    const dying = scriptedModel(callsTool("run_read_query", { sql: "SELECT id FROM orders" }));

    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(dying.fetch),
        resources: first.resources,
      }),
    ).rejects.toThrow();

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("continuing"));
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    expect(second.queryReadOnly).not.toHaveBeenCalled();
    expect(second.acquireProvider).not.toHaveBeenCalled();
    const captures = (await eventsOf(second.store, run.runId)).filter((event) => event.kind === "context-captured");
    expect(captures).toHaveLength(1);
    // And the reused inventory is what the resumed model is shown.
    const fingerprint = captures[0] && "fingerprint" in captures[0] ? captures[0].fingerprint : "";
    expect(resumed.turns[0]?.transcript).toContain(fingerprint);
  });

  test("a recorded capture carrying no inventory is read again rather than trusted", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    await first.service.markRunning(run.runId);
    // What a hand-written fixture, or a ledger written before the inventory was
    // persisted, carries: the summary without the rows behind it.
    await first.service.recordEvent(run.runId, { kind: "context-captured", fingerprint: "ctx_old", tableCount: 2 });

    const second = boot(dataDir);
    const resumed = scriptedModel(answersProse("continuing"));
    await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(resumed.fetch),
      resources: second.resources,
    });

    expect(second.queryReadOnly).toHaveBeenCalledTimes(CONTEXT_READS);
    expect((await eventsOf(second.store, run.runId)).filter((event) => event.kind === "context-captured")).toHaveLength(
      2,
    );
  });

  /*
    The case the whole grounding design exists for: the COLD PROCESS. Nothing is
    held, nothing is in the ledger, and this is what a plan run met after every
    restart, on every second replica, and for every user who had not already run
    agent mode on this connection. It used to be told it had seen nothing; it now
    reads its own catalog, server-side, before the first turn.

    This test asserted the opposite until 2026-08-15 ("a planning run captures
    nothing and reaches no database"). It is rewritten rather than deleted because
    the owner moved the invariant deliberately — see `docs/superpowers/specs/
    2026-08-15-plan-mode-sql-generator-design.md`, item 1 — and what replaces it is
    the narrower promise the product actually makes.
  */
  test("a planning run on a cold process captures its own context, and still sends no statement of the user's", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("I would start with the index."));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // Grounded from nothing: the same three composed catalog reads an agent run
    // takes, recorded in the ledger so a later drive of this run reuses them.
    expect(modelStatements(b.queryReadOnly)).toEqual([expect.stringContaining("pg_stats") as unknown as string]);
    expect(userStatements(b.queryReadOnly)).toEqual([]);
    expect(kindsOf(await eventsOf(b.store, run.runId))).toContain("context-captured");
    // The model is told the reading was its own run's, and is told it in the
    // server's own voice: never in the capture's words, which send a model to
    // `inspect_schema` — a tool this mode does not have, so naming it would be the
    // #350 failure exactly.
    expect(script.turns[0]?.transcript).not.toContain("inspect_schema");
    expect(script.turns[0]?.transcript).toContain("read from this database by this run");
    expect(rulesOfTurn(script.turns[0] as Turn)).toContain(
      "A schema inventory for this database is in this conversation",
    );
    // And no tools, on the turn that was given all of it.
    expect(script.turns[0]?.body.tools).toBeUndefined();
  });

  test("a catalog the run cannot read leaves the run going, and says what to do instead", async () => {
    const b = boot(freshDataDir(), {
      answer: async (sql) => {
        if (sql.includes("pg_index")) throw new QueryError("permission denied for relation pg_index", "postgres");
        return queryResult();
      },
    });
    const run = await startRun(b);
    const script = scriptedModel(answersProse("I will inspect it myself."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("succeeded");
    // No half-inventory is recorded, and the model is told to read the schema itself.
    expect(kindsOf(await eventsOf(b.store, run.runId))).not.toContain("context-captured");
    expect(script.turns[0]?.transcript).toContain("inspect_schema");
  });
});

/*
  The gate the model has to satisfy, told to the model. #350 and #356 are the same
  failure twice: a rule stated only in the server is a rule live runs fail. The
  auto-execute gate needs a plan of the answer's own statement, and nothing obtains
  one on the model's behalf — so a run never told to ask for one could never pass a
  gate the user had ticked, and every gate here would stay green while it happened.
*/
describe("a run opened with auto-execute is told what the gate needs", () => {
  const rulesOf = (turn: Turn): string => {
    const messages = (turn.body.messages ?? []) as { role?: string; content?: unknown }[];
    const system = messages.find((message) => message.role === "system");
    return typeof system?.content === "string" ? system.content : "";
  };

  test("the rule names the plan the gate reads, and the bound the editor does not have", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    const script = scriptedModel(answersProse("ok"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const rules = rulesOf(script.turns[0] as Turn);
    expect(rules).toContain("AUTO-EXECUTE IS ON");
    expect(rules).toContain("call inspect_plan on the statement that IS the answer");
    expect(rules).toContain("without the time limit");
  });

  test("a run opened without it is told nothing: a rule about what cannot happen is noise", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis");
    const script = scriptedModel(answersProse("ok"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(rulesOf(script.turns[0] as Turn)).not.toContain("AUTO-EXECUTE IS ON");
  });

  test("a workflow with no present_answer is told nothing either, whatever the record says", async () => {
    // The third condition, and the one that shipped wrong: the record can carry
    // `autoExecute: true` on a run whose tool set has no `present_answer` — a ledger
    // written before the route refused it, or a workflow that loses the tool later.
    // Stating the rule there would tell the model to "call inspect_plan on the
    // statement that IS the answer before you present it" and then offer it no way to
    // present one, which is a rule stated to a model whose tool set cannot satisfy it
    // (#350/#356). Asserted over every non-presenting workflow, not a sample.
    for (const workflowType of ["investigation", "query-optimization", "database-assessment", "operations"] as const) {
      const b = boot(freshDataDir());
      const run = await startRun(b, "agent", workflowType, true);
      const script = scriptedModel(answersProse("ok"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      expect(rulesOf(script.turns[0] as Turn), workflowType).not.toContain("AUTO-EXECUTE IS ON");
    }
  });
});

describe("the handover an answer records comes from the run's own setting", () => {
  /** Presents whatever result this run has already read, as a table. */
  const presentsTheRead =
    (callId = "call_answer") =>
    (turn: Turn): Response =>
      chatToolCallStream(
        "present_answer",
        JSON.stringify({ artifact: correlationIdIn(turn.transcript), presentation: { kind: "table" } }),
        callId,
      );

  async function answerOf(autoExecute: boolean) {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", autoExecute);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "the question, in SQL" }),
      presentsTheRead(),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const composed = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "answer-composed");
    if (composed?.kind !== "answer-composed") throw new Error("this drive composed no answer");
    return composed;
  }

  test("a run opened without it hands nothing anywhere, and says so", async () => {
    const composed = await answerOf(false);

    expect(composed.handover).toBe("none");
    expect(composed.handoverWarning).toBeUndefined();
  });

  test("a run opened with it, whose gate declined, records the refusal rather than a silent skip", async () => {
    // This drive inspected no plan, so condition 2 cannot hold — which is the point:
    // the setting reached the tool from the RUN RECORD, and the gate still refused.
    const composed = await answerOf(true);

    expect(composed.handover).toBe("applied");
    expect(composed.handoverWarning).toContain("Not run for you");
  });

  test("a model that presents twice leaves ONE answer on the ledger, and is told why", async () => {
    /*
      The tool is non-terminal, so the loop lets the model keep going after an answer —
      and before #373 the second call succeeded exactly like the first. Two
      `answer-composed` entries mean two statements the rail delivers to the editor and,
      on an auto-execute run, two it RUNS there with no timeout, under a checkbox that
      promised the final answer. The guard is server-side and reads the run's own events,
      so it holds however the second call is worded.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "the question, in SQL" }),
      presentsTheRead("call_answer_1"),
      presentsTheRead("call_answer_2"),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const composed = (await eventsOf(b.store, run.runId)).filter((event) => event.kind === "answer-composed");
    expect(composed).toHaveLength(1);
    // And the refusal reached the model rather than the run simply dying: the turn
    // AFTER the second presentation carries the tool result it was answered with.
    const transcript = (script.turns.at(-1) as Turn).transcript;
    expect(transcript).toContain("This run has already recorded its answer");
    expect(transcript).toContain("compose_report");
  });
});

/*
  A presentation the model SERIALIZED, driven through the real SDK (#406).

  `tests/unit/lib/agent/tools.test.ts` calls `presentAnswerTool` directly, so every
  one of its cases enters the tool with whatever object the test wrote. That is not
  the path a model's arguments take. Between the wire and the tool sits `streamText`,
  which validates the model's arguments against the SAME `inputSchema`
  `declaredTools()` handed it — and that schema, correctly, does not accept a string
  where the presentation object belongs. Measured against `ai@7.0.59`: it throws
  `InvalidToolInputError` at `doParseToolCall`, CATCHES it, re-parses the raw JSON
  without a schema and enqueues the tool-call part anyway with `invalid: true`, plus a
  `tool-error` part and its own `role: "tool"` result message.

  So the serialized presentation reaches `readSerializedPresentation` only because of
  two properties of `takeTurn` that nothing else names: it pushes every `tool-call`
  part without consulting `part.invalid` (src/lib/agent/investigation.ts:1042), and it
  keeps only `role: "assistant"` response messages, discarding the SDK's error result
  (src/lib/agent/investigation.ts:1069). Hardening the first to
  `part.invalid !== true` — the shape `capability-probe.ts:279` already uses, so it is
  a natural edit rather than a hypothetical one — deletes #406's entire behaviour
  gain: the call is dropped, the turn looks like "the model stopped", and the run is
  scored with no answer and nothing on the ledger saying why.

  Measured by applying that edit: 7 of this file's 83 tests fail with it, and none of
  the other six was watching THIS. They all sit on the REFUSAL path — a malformed
  argument list must come back as a typed `INVALID_TOOL_INPUT`, and an unoffered tool
  as "no such tool" — where an invalid call being dropped instead of dispatched costs
  the model its explanation. The success path, where a call the SDK flags is
  nevertheless one the tool can serve, had no test at all before this one, and it is
  the only path #406 exists to buy.
*/
describe("a presentation the model serialized reaches the tool through the SDK", () => {
  /*
    The measured shape, not a simplified one. `qwen3.8` sent a chart spec as a JSON
    string; a serialized `{ kind: "table" }` would round-trip through one `JSON.parse`
    without proving the nested spec survives, and the nested object is where a
    field-by-field re-encoding would have gone wrong.
  */
  const SERIALIZED_CHART = JSON.stringify({
    kind: "chart",
    spec: { type: "bar", x: "month", y: ["total"], caption: "Orders by month" },
  });

  const ANSWERABLE = "SELECT month, total FROM orders";

  /** The two-row numeric result a chart can legally show; catalog reads answer as usual. */
  const bootWithChartableRead = () =>
    boot(freshDataDir(), {
      answer: async (sql) =>
        sql.includes(ANSWERABLE)
          ? queryResult({
              rows: [
                { month: "2026-01", total: 11 },
                { month: "2026-02", total: 22 },
              ],
              fields: ["month", "total"],
              rowCount: 2,
            })
          : queryResult(),
    });

  test("the run is ANSWERED, and the SDK's own refusal never reaches the transcript", async () => {
    const b = bootWithChartableRead();
    const run = await startRun(b, "agent", "data-analysis");
    const script = scriptedModel(
      callsTool("run_read_query", { sql: ANSWERABLE, rationale: "the question, in SQL" }),
      (turn: Turn): Response =>
        chatToolCallStream(
          "present_answer",
          JSON.stringify({ artifact: correlationIdIn(turn.transcript), presentation: SERIALIZED_CHART }),
          "call_answer",
        ),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const composed = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "answer-composed");
    if (composed?.kind !== "answer-composed") throw new Error("the serialized presentation composed no answer");
    // The spec inside the string, read back whole — not a table fallback, which is
    // what a presentation the tool failed to understand would have produced.
    expect(composed.presentation).toEqual({
      kind: "chart",
      spec: { type: "bar", x: "month", y: ["total"], caption: "Orders by month" },
    });

    // And the second dependency, on the turn after the answer: exactly ONE tool
    // result for that call id — this loop's. The SDK authored one too, and two
    // results for one `tool_call_id` is a transcript a real endpoint answers with a
    // 400, which would wedge every later turn of the run rather than this one. The
    // counterpart of the assertion at the "two results in the transcript" test above,
    // which measures the same filter on the path where the call is REFUSED.
    const messages = (script.turns[2]?.body.messages ?? []) as { role?: string; tool_call_id?: string }[];
    expect(messages.filter((m) => m.role === "tool" && m.tool_call_id === "call_answer")).toHaveLength(1);
  });

  test("the SDK does mark that call invalid — the fact the dispatch above rests on", async () => {
    // Driven through `streamText` with the tool declared exactly as `declaredTools()`
    // declares it, because this is the claim the comment on `readSerializedPresentation`
    // makes about a dependency this repository does not own. If a future `ai` release
    // stops flagging the call, this test is where that shows up, and the read at the
    // call boundary can stop being load-bearing.
    const definition = AGENT_TOOL_DEFINITIONS.present_answer;
    const script = scriptedModel(
      (): Response =>
        chatToolCallStream(
          "present_answer",
          JSON.stringify({ artifact: "corr_1", presentation: SERIALIZED_CHART }),
          "call_answer",
        ),
    );

    const stream = streamText({
      model: (await modelOver(script.fetch)).model,
      messages: [{ role: "user", content: OBJECTIVE }],
      tools: { present_answer: tool({ description: definition.description, inputSchema: definition.inputSchema }) },
      maxRetries: 0,
      onError: () => {},
    });

    const calls: { invalid?: boolean; input: unknown }[] = [];
    for await (const part of stream.fullStream) {
      if (part.type === "tool-call") calls.push({ invalid: part.invalid, input: part.input });
    }

    expect(calls).toHaveLength(1);
    const call = calls[0] as { invalid?: boolean; input: { presentation?: unknown } };
    expect(call.invalid).toBe(true);
    // Unparsed, too: the SDK's fallback re-parse has no schema, so the string arrives
    // at the tool exactly as the model wrote it. That is what the boundary read reads.
    expect(typeof call.input.presentation).toBe("string");
  });
});
