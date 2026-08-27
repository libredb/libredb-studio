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
  guidanceDelivered,
  PLAN_NO_REASONING_EFFORT,
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
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { KEY_PATTERN_LABELS, SEARCH_INDEX_LABELS, TABLE_LABELS } from "../fixtures/provider-labels";
import { LLMAuthError } from "@/lib/llm/types";
import type { ColumnSchema, DatabaseConnection, DatabaseType, QueryResult, TableSchema } from "@/lib/types";
import {
  type Turn,
  answersProse,
  callsTool,
  correlationIdIn,
  correlationIdsIn,
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
  /**
   * What the provider says when asked to describe its own schema (#414).
   *
   * Absent means a `getSchema()` that REJECTS, which is the shape a provider that
   * cannot describe this database really has: `getSchema` is a required member of
   * `DatabaseProvider`, so no provider reaching this path is missing it, and the
   * reachable failure is a rejection. Supplying one is how a run on a dialect with no
   * catalog plan becomes GROUNDED, which is the case #414 exists for.
   */
  readonly describesSchema?: () => Promise<readonly TableSchema[]>;
}

function boot(dataDir: string, options: BootOptions = {}): Boot {
  const answer = options.answer ?? (async () => queryResult());
  const queryReadOnly = mock((sql: string) => answer(sql));
  const provider = {
    queryReadOnly,
    getSchema:
      options.describesSchema ??
      (async (): Promise<readonly TableSchema[]> => {
        throw new QueryError("this database refused to describe its own schema");
      }),
  } as unknown as DatabaseProvider;
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
      labels: TABLE_LABELS,
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
const CATALOG_READS = ["information_schema.columns", "pg_constraint", "pg_index"] as const;

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
const GROUNDING_READ_MARKERS = ["information_schema.columns", "pg_constraint", "pg_index", "pg_stats"] as const;

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
  /*
    The PROSE protocol, which had no test coverage at all until now.

    `toolProtocol: "prompted"` is the path a whole family of reasoning distills takes, because none of
    them can emit `tool_calls`. Four of the 25 measured models go through it and between them
    they lock 2 cells of 24 — and the reason no test ever caught why is that no test ever ran
    this branch. Adding the parameter is the cheap half of fixing that.
  */
  toolProtocol?: "native" | "prompted",
): Promise<AgentRunRecord> {
  return boot.service.start({
    mode,
    actor: ACTOR,
    connectionId: "conn_1",
    objective: OBJECTIVE,
    ...(workflowType === undefined ? {} : { workflowType }),
    ...(autoExecute === undefined ? {} : { autoExecute }),
    ...(toolProtocol === undefined ? {} : { toolProtocol }),
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
      "driver-resolved",
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
      // Reminded once after a reading, the model narrates again rather than reporting.
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
      "driver-resolved",
      "context-captured",
      "tool-invoked",
      "tool-completed",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      // This run ends on prose rather than a report, and the prose is now written twice on
      // purpose, under two names that mean different things. `model-stopped-saying` is the
      // diagnostic — what the model said as it STOPPED, the shape 190 of 277 measured
      // `no-report` runs ended in — and `closing-statement` is what the run leaves behind for
      // a reader. An agent run's stopping prose is discarded by the verdict, so without the
      // first entry the largest failure group in the measurements had no explanation in it.
      "guidance-issued",
      "model-stopped-saying",
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
    const script = scriptedModel(
      callsTool("run_read_query", { sql: 42 }),
      answersProse("understood"),
      answersProse("understood"),
    );

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
      // Reminded once after a reading, the model narrates again rather than reporting.
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
    const script = scriptedModel(
      callsTool("run_read_query", { sql: 42 }),
      answersProse("understood"),
      answersProse("understood"),
    );

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
      // Reminded once after a reading, the model narrates again rather than reporting.
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
    The workflow a plan run was NOT grounded for until #411, and the exclusion it lost.

    The premise was that an operations objective is not about the schema. That is true
    about the QUESTION and false about the evidence: the engine's own reports are full
    of schema identifiers, and a run that has never seen the inventory reads them as
    opaque strings. So an operations plan is grounded like every other workflow now,
    and what stays workflow-specific is what is PACKED — names and indexes, no columns
    and no relations — and what is asked of it, which is still prose.

    Its sentence is still its own rather than the agent mode's, because
    `OPERATIONS_CONTEXT_NOTE` tells the model to take readings with `inspect_operations`
    and a planning run has no tools at all: naming one it does not have is the #350
    failure. Both halves are asserted, since the note being merely PRESENT would pass
    just as well with the wrong one of the two.
  */
  test("an operations plan reads its own inventory, is told what it holds, and is told of no tool", async () => {
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
    // Grounded from its own catalog read, recorded so a later drive of this run reuses
    // it, and still no statement of the user's.
    expect(kindsOf(await eventsOf(b.store, run.runId))).toContain("context-captured");
    expect(userStatements(b.queryReadOnly)).toEqual([]);
    // The rules point at the inventory it was actually given, rather than telling it
    // that it has seen nothing.
    const rules = rulesOfTurn(script.turns[0] as Turn);
    expect(rules).toContain("A schema inventory for this database is in this conversation");
    expect(rules).not.toContain("No schema inventory is available to this run");
    expect(result.status).toBe("succeeded");
  });

  /*
    The invariant the whole shape of #411 rests on: the CAPTURE stays whole, and only
    the presentation varies.

    `holdSnapshotForConnection` shares one reading between runs, and `context-snapshot.ts`
    states that an inventory is all-or-nothing because "an inventory missing its keys
    while claiming to be whole is worse than no inventory". So an operations-shaped
    partial capture would be handed to a LATER run of another workflow as if it were
    complete. Nothing pinned that until review asked for it: a change that made the
    operations capture operations-shaped — the exact temptation the design bans — would
    have left every other test in this change green.

    Driven as two runs in one process, because that is the only place the sharing is
    observable: the operations run fills the hold, and a plan run of another workflow is
    grounded from it without reading a catalog again.
  */
  test("the inventory an operations run captures is the whole one a later run is handed", async () => {
    /** Two related tables, so "whole" is visible as a column type and as a foreign key. */
    const catalog = async (sql: string): Promise<QueryResult> => {
      if (sql.includes("information_schema.columns")) {
        return queryResult({
          rows: [
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "customer_id",
              data_type: "character varying",
              is_nullable: "NO",
            },
            {
              table_schema: "public",
              table_name: "customers",
              column_name: "id",
              data_type: "character varying",
              is_nullable: "NO",
            },
          ],
          fields: ["table_schema", "table_name", "column_name", "data_type", "is_nullable"],
          rowCount: 2,
        });
      }
      if (sql.includes("pg_constraint")) {
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
          fields: [
            "table_schema",
            "table_name",
            "column_name",
            "referenced_schema",
            "referenced_table",
            "referenced_column",
          ],
          rowCount: 1,
        });
      }
      return queryResult({ rows: [], fields: [], rowCount: 0 });
    };
    const b = boot(freshDataDir(), { answer: catalog });
    const operationsRun = await startRun(b, "agent", "operations");
    const operationsScript = scriptedModel(answersProse("nothing to add"));
    await runInvestigation(operationsRun.runId, {
      service: b.service,
      model: await modelOver(operationsScript.fetch),
      resources: b.resources,
    });
    const catalogReadsSoFar = b.queryReadOnly.mock.calls.length;

    const laterRun = await startRun(b, "planning", "investigation");
    const laterScript = scriptedModel(answersProse("```postgres\nSELECT id FROM orders\n```"));
    await runInvestigation(laterRun.runId, {
      service: b.service,
      model: await modelOver(laterScript.fetch),
      resources: b.resources,
    });

    const transcript = laterScript.turns[0]?.transcript ?? "";
    // The parts an operations run is not shown, present for the run that is: the columns
    // with their types, and the foreign key — which is the half `context-snapshot.ts`
    // names when it says a partial inventory is worse than none.
    expect(transcript).toContain("character varying");
    expect(transcript).toContain("schema relations");
    expect(transcript).toContain('public.orders\\" -> \\"public.customers');
    // And it came out of the hold rather than from a second catalog read. The statistics
    // read is a plan run's own and is not part of the inventory, so this compares the
    // catalog reads alone.
    const laterCatalogReads = b.queryReadOnly.mock.calls
      .slice(catalogReadsSoFar)
      // Matched on the catalog reads' own FROM clauses: the statistics statement names
      // `information_schema` too, in a NOT IN list, and so does the relation read.
      .filter(([sql]) => typeof sql === "string" && /information_schema\.columns|FROM pg_constraint/.test(sql));
    expect(laterCatalogReads).toEqual([]);
  });

  /*
    The other half of the same decision: the relations graph is the most expensive part
    of the packing and the least useful part here, so it is not packed at all — for
    either mode. Asserted on the transcript rather than on a call, because what matters
    is what reached the model.
  */
  /*
    The note and the block have to AGREE, on the axis that actually varies with the
    user's database: complete versus truncated.

    The grounded/ungrounded axis was pinned from the start. This one was not, and the
    note asserted "the name of every table this connection holds" while
    `packOperationsInventory` is bounded at 6000 fenced characters and drops its tail —
    two claims in one conversation, one of them the SERVER'S own unfenced voice, which is
    the one a model believes. The failure it produces is precise and is exactly the job
    the inventory exists to do: a lock reported on a table the packing left out reads as a
    relation this database does not have.
  */
  test("an operations run whose inventory was truncated is not told it holds every table", async () => {
    /** Wider than the pack can hold, so the omission line is reached. */
    const wide = async (sql: string): Promise<QueryResult> =>
      sql.includes("information_schema.columns")
        ? queryResult({
            rows: Array.from({ length: 300 }, (_unused, index) => ({
              table_schema: "public",
              table_name: `department_table_${index}`,
              column_name: "identifier_column",
              data_type: "character varying",
              is_nullable: "NO",
            })),
            fields: ["table_schema", "table_name", "column_name", "data_type", "is_nullable"],
            rowCount: 300,
          })
        : queryResult({ rows: [], fields: [], rowCount: 0 });

    for (const mode of ["agent", "planning"] as const) {
      const b = boot(freshDataDir(), { answer: wide });
      const run = await startRun(b, mode, "operations");
      const script = scriptedModel(answersProse("understood"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      const transcript = script.turns[0]?.transcript ?? "";
      expect(transcript).toContain("further table(s) exist in this database and are not named here.");
      expect(transcript).toContain("as much of the inventory as fits");
      // The two spellings of the claim the bound makes false.
      expect(transcript).not.toContain("every table this connection holds");
      expect(transcript).not.toContain("every table it holds");
    }
  });

  test("an operations run is shown no relations graph and no columns, in either mode", async () => {
    for (const mode of ["agent", "planning"] as const) {
      const b = boot(freshDataDir());
      const run = await startRun(b, mode, "operations");
      const script = scriptedModel(answersProse("understood"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      const transcript = script.turns[0]?.transcript ?? "";
      expect(transcript).toContain("Names and the indexes on each");
      expect(transcript).not.toContain("schema relations");
    }
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
      if (sql.includes("pg_constraint")) {
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
      The reuse, on the ledger, with the age of the reading (B56).

      `holdSnapshotForConnection` has no expiry: newest reading wins, eviction is by use,
      nothing re-reads. Measured 2026-08-22 — MongoDB's schema inference was changed, the
      schema tree showed the new dotted paths at once, and two plan runs afterwards still
      grouped by the old field with ledgers carrying no context event at all. So the record
      could not tell "held, hours old" from "captured just now", and the only diagnosis
      available was restarting the process.

      Two hours are expressed as two clock readings rather than as a wait: the age is
      measured against the drive's own clock, which is the seam these runs are given.
    */
    test("it records the reading it reused, and how old that reading was when it took it", async () => {
      const capturedAtMs = 1_000_000;
      const reader = boot(freshDataDir(), { answer: catalog });
      const readerRun = await startRun(reader, "agent");
      const readerScript = scriptedModel(answersProse("understood"));
      await runInvestigation(readerRun.runId, {
        service: reader.service,
        model: await modelOver(readerScript.fetch),
        resources: { ...reader.resources, clock: () => capturedAtMs },
      });
      const capture = (await eventsOf(reader.store, readerRun.runId)).find(
        (event) => event.kind === "context-captured",
      );

      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "planning");
      const script = scriptedModel(answersProse("a plan"));
      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: { ...b.resources, clock: () => capturedAtMs + 7_200_000 },
      });

      const events = await eventsOf(b.store, run.runId);
      const reused = events.find((event) => event.kind === "context-reused");
      expect(reused).toBeDefined();
      expect(reused?.ageMs).toBe(7_200_000);
      // The reading it names is the one the earlier run recorded, which is what makes the
      // entry provenance rather than a note that something was reused.
      expect(reused?.fingerprint).toBe(capture?.fingerprint);
      expect(reused?.tableCount).toBe(2);
      // And it is NOT recorded as this run's own capture: no catalog was read here, and an
      // entry saying otherwise would let a later drive re-derive an inventory this run
      // never took.
      expect(kindsOf(events)).not.toContain("context-captured");
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
      // It is told WHY, in the capture's own words and without naming a tool it does
      // not have (#350). Until #414 this note was written by `investigation.ts` and
      // named the engine ("on this mongodb connection"), because the engine WAS the
      // reason: `CATALOG_PLANS` refused the dialect before touching anything. Now the
      // dialect only decides which of two readings is taken, and what this run is told
      // is the thing that actually stopped it — the same forwarding `operations` has
      // done since #411, for the reason #411 recorded. What stopped it is a
      // `getSchema()` that rejected, which is the only shape "this provider cannot
      // describe the database" has: the method is required on `DatabaseProvider`.
      expect(script.turns[0]?.transcript).toContain("this database refused to describe its own schema");
      expect(script.turns[0]?.transcript).not.toContain("inspect_schema");
      // Since #414 the capture DOES acquire a provider here, under the operations
      // profile, and asks it to describe itself; this fixture's provider carries only
      // `queryReadOnly`, so the reading is refused and the run is ungrounded exactly
      // as it was. What has not changed, and is what this line now pins, is that no
      // STATEMENT is composed for a dialect no catalog is written for.
      expect(b.queryReadOnly).not.toHaveBeenCalled();
    });

    /*
      #414. A dialect with no catalog plan is no longer refused on the dialect: it asks
      its PROVIDER for the same inventory, and on twelve type-ids it gets one. Everything
      the run is then TOLD has to change with it, because four separate sentences were
      written for the composed path and are false on this one — how the reading was
      taken, what language to answer in, what an empty relations block means, and what
      the statistics block's absence means.

      The fixture is deliberately a `mongodb` connection with `queryLanguage: "json"`
      and `declaresForeignKeys: false`, which is what that provider really declares.
    */
    describe("a plan run grounded through the engine's own schema inspection", () => {
      const column = (name: string): ColumnSchema => ({ name, type: "string", nullable: true, isPrimary: false });
      const PROVIDER_INVENTORY: readonly TableSchema[] = [
        { name: "orders", columns: [column("customerId")], indexes: [], foreignKeys: [] },
        { name: "customers", columns: [column("name")], indexes: [], foreignKeys: [] },
      ];

      const planOnProvider = async (
        language: ProviderCapabilities["queryLanguage"],
        labels?: ProviderLabels,
      ): Promise<{ readonly rules: string; readonly transcript: string }> => {
        const b = boot(freshDataDir(), { describesSchema: async () => PROVIDER_INVENTORY });
        const run = await startRun(b, "planning");
        const script = scriptedModel(answersProse("a plan"));

        await runInvestigation(run.runId, {
          service: b.service,
          model: await modelOver(script.fetch),
          resources: {
            ...b.resources,
            connection: { ...CONNECTION, type: "mongodb" },
            capabilities: { ...CAPABILITIES, queryLanguage: language, declaresForeignKeys: false },
            ...(labels === undefined ? {} : { labels }),
          },
        });

        const turn = script.turns[0] as Turn;
        return { rules: rulesOf(turn), transcript: turn.transcript };
      };

      /*
        The other half of the 2x2. WHO read it and HOW are separate facts, and a run
        handed a provider-sourced reading out of the process hold has to say both — the
        `earlier-run` sentence written for the composed path would tell it the server
        composed a catalog read that never happened.
      */
      test("a run handed a provider reading by an earlier run says both who read it and how", async () => {
        // The first fills the hold; `beforeEach` cleared it, so nothing else can.
        await planOnProvider("json");
        const { transcript } = await planOnProvider("json");

        expect(transcript).toContain("by an earlier run on this connection");
        expect(transcript).toContain("through the engine's own schema inspection");
        expect(transcript).toContain("so this run did not have to read it again");
        expect(transcript).not.toContain("a read-only catalog read the server composed");
        // The bound travels on both arms: it is a property of the reading, not of who
        // paid for it.
        expect(transcript).toContain("not proof that nothing else exists");
      });

      test("it is grounded, and the inventory it was shown is this engine's own", async () => {
        const { rules, transcript } = await planOnProvider("json");

        expect(rules).toContain("A schema inventory for this database is in this conversation");
        expect(rules).not.toContain("No schema inventory is available to this run");
        expect(transcript).toContain("orders");
        expect(transcript).toContain("customers");
      });

      /*
        The preface is the run describing to the model how it came by what it knows,
        and the composed sentence is false here in both directions: the server wrote no
        statement, and what it did instead is the reading the sidebar takes. Saying
        otherwise would be the false self-description this repository keeps finding,
        stated to the model itself.
      */
      test("the preface says the engine described itself, not that the server composed a catalog read", async () => {
        const { transcript } = await planOnProvider("json");

        expect(transcript).toContain("through the engine's own schema inspection");
        expect(transcript).toContain("the same reading this product performs when it lists your tables");
        expect(transcript).not.toContain("a read-only catalog read the server composed");
      });

      /*
        The bound nobody had stated. MongoDB stops at 200 collections, Redis scans 1000
        keys, LibreDB 10000 — so a provider inventory can be a PARTIAL reading carrying
        a whole-looking table count, and a model told only "here is the inventory" would
        conclude from a table's absence that it does not exist. The clause also refuses
        the easier claim that nothing of the data was touched: on this engine the field
        names are inferred from a sample of the user's own documents.
      */
      test("the preface says the reading is bounded and may have sampled rather than enumerated", async () => {
        const { transcript } = await planOnProvider("json");

        expect(transcript).toContain("infers a table's fields from a sample of its own rows");
        expect(transcript).toContain("not proof that nothing else exists");
      });

      /*
        The deliverable stops assuming SQL. The fence TAG does not move with it — it is
        the canonical type-id in both arms, because `isQueryFenceTag` is a total record
        over `DatabaseType` and a draft the model fences as ```javascript records no
        `plan-statement-drafted` event at all.
      */
      test("a json engine is asked for its own language, in a block still tagged with its type-id", async () => {
        const { rules } = await planOnProvider("json");

        expect(rules).toContain("written in this mongodb database's own query language");
        expect(rules).toContain("This engine speaks no SQL");
        expect(rules).toContain("Put it in a single fenced block tagged `mongodb`");
        // The SQL arm's own opening, which must not also be present: one message with
        // two contracts in it leaves the model to pick (the #350 failure).
        expect(rules).not.toContain("Produce ONE runnable statement: the statement that answers the question.");
        // And the vocabulary warning, because this product records every engine's
        // inventory under the words table and column.
        expect(rules).toContain("those are the names of its own objects and of the fields inside them");
      });

      /*
        The gap a live run found, and the reason it is a LABEL rather than a branch on
        the engine name. Measured 2026-08-19 in the browser: a plan run on an
        OpenSearch connection, told only "produce ONE runnable statement", answered
        with a native aggregation body — `{"size":0,"aggs":{…},"query":{"term":{…}}}` —
        which is correct for the product and unrunnable through the SQL endpoint this
        provider speaks to. `queryLanguage: "sql"` was already true and said nothing to
        the model; the engine's NAME carried the stronger prior. So the provider now
        declares what its statements are written in, and the contract states it.
      */
      test("an engine that declares a statement language has it stated in the contract", async () => {
        const { rules } = await planOnProvider("sql", SEARCH_INDEX_LABELS);

        expect(rules).toContain("Write it in Elasticsearch SQL, the product's own SQL endpoint");
        expect(rules).toContain("NOT the JSON query DSL");
        // Still the SQL contract: the language sentence adds to it rather than
        // replacing it, or the model would be handed two contracts to pick from.
        expect(rules).toContain("Produce ONE runnable statement");
      });

      test("an engine that declares none is told nothing extra about its language", async () => {
        // A connection stamped `postgres` needs nobody to add that its statements are
        // SQL, and a sentence saying so would spend prompt on what the dialect line
        // already carries.
        const { rules } = await planOnProvider("sql");

        expect(rules).not.toContain("Write it in");
      });

      test("a SQL engine reached the same way still gets the SQL contract, so the LANGUAGE decides and not the path", async () => {
        const { rules, transcript } = await planOnProvider("sql");

        expect(transcript).toContain("through the engine's own schema inspection");
        expect(rules).toContain("Produce ONE runnable statement: the statement that answers the question.");
        expect(rules).not.toContain("This engine speaks no SQL");
      });

      /*
        An engine that declares no foreign keys and a read that saw none are different
        facts, and the block says which one it has. On an engine with no such construct
        the other sentence — the one about what this reading was allowed to see — would
        report a read limit where there was nothing to read, so it must not appear.
      */
      test("an engine that cannot declare a foreign key is not described as one that declared none", async () => {
        const { transcript } = await planOnProvider("json");

        expect(transcript).toContain("this engine does not declare foreign keys at all");
        expect(transcript).not.toContain("not the same as there being none");
      });

      /*
        Statistics: no code changed here, and this pins that the combination reads
        correctly now that it is the ORDINARY case rather than a rare one. A schema is
        known, no statistics are, and the two sentences the run is handed agree — the
        inventory is a record of what exists, and the estimates simply do not exist on
        this engine.
      */
      test("a known schema with no statistics says both things, and neither contradicts the other", async () => {
        const { rules, transcript } = await planOnProvider("json");

        expect(transcript).toContain("this engine does not hold statistics this run knows how to read");
        expect(rules).toContain("It is a record of what exists — not of how many rows anything holds");
        expect(rules).not.toContain("Estimated statistics are in the conversation beside it");
      });

      /*
        The RULES' own provenance sentence, which is a second 2x2 over the same two axes
        as the preface and was left one-dimensional when the preface was made four.

        The consequence was the exact defect #414 exists to close, stated to the model
        itself: a grounded MongoDB plan run was told in its rules that its inventory came
        "through the same read-only catalog path the agent mode uses", and in the very
        next message that it came from the engine's own inspection. Both halves of the
        first were false there — no catalog statement is composed on this dialect, and
        agent mode cannot take a read-only path on it at all. Nothing asserted this
        string, which is why no gate caught it, so all four are pinned here in full.
      */
      const PROVENANCE = {
        composedThisRun:
          "It was read from the database by this run itself, before your first turn, through the same read-only catalog path the agent mode uses: no statement of the user's was run, nothing was written, and you have no tools and will read nothing further.",
        composedEarlierRun:
          "It was read by an EARLIER run on this connection rather than by this one, which is why this run did not have to read it again: no statement of the user's was run, nothing was written, and you have no tools and will read nothing further.",
        providerThisRun:
          "It was read from the database by this run itself, before your first turn, through the engine's own schema inspection rather than a catalog statement the server composed — the same reading this product performs when it lists your tables: no statement of the user's was run, nothing was written, and you have no tools and will read nothing further.",
        providerEarlierRun:
          "It was read by an EARLIER run on this connection rather than by this one, through the engine's own schema inspection rather than a catalog statement the server composed, which is why this run did not have to read it again: no statement of the user's was run, nothing was written, and you have no tools and will read nothing further.",
      } as const;

      test("the rules say the engine described itself, and never that a catalog path was taken", async () => {
        const { rules } = await planOnProvider("json");

        expect(rules).toContain(PROVENANCE.providerThisRun);
        expect(rules).not.toContain(PROVENANCE.composedThisRun);
        // The clause that made it false, named on its own: agent mode reaches no
        // read-only path here at all, so a rule claiming this run took one describes a
        // path that does not exist on this engine.
        expect(rules).not.toContain("the same read-only catalog path the agent mode uses");
      });

      test("a provider reading from an earlier run is described as one in the rules too", async () => {
        await planOnProvider("json");
        const { rules } = await planOnProvider("json");

        expect(rules).toContain(PROVENANCE.providerEarlierRun);
        expect(rules).not.toContain(PROVENANCE.composedEarlierRun);
      });

      /*
        And the two arms that were already right, so the correction cannot be applied by
        deleting the distinction: on PostgreSQL the server really does compose the
        catalog read, and agent mode really does take the same one.
      */
      test("a composed reading keeps its own two sentences", async () => {
        const first = boot(freshDataDir(), { answer: catalog });
        const firstRun = await startRun(first, "planning");
        const firstScript = scriptedModel(answersProse("a plan"));
        await runInvestigation(firstRun.runId, {
          service: first.service,
          model: await modelOver(firstScript.fetch),
          resources: first.resources,
        });

        expect(rulesOf(firstScript.turns[0] as Turn)).toContain(PROVENANCE.composedThisRun);

        // The same connection, a second process: the reading is now the hold's.
        const second = boot(freshDataDir(), { answer: catalog });
        const secondRun = await startRun(second, "planning");
        const secondScript = scriptedModel(answersProse("a plan"));
        await runInvestigation(secondRun.runId, {
          service: second.service,
          model: await modelOver(secondScript.fetch),
          resources: second.resources,
        });

        expect(rulesOf(secondScript.turns[0] as Turn)).toContain(PROVENANCE.composedEarlierRun);
      });
    });

    /*
      #414, second finding, and it came from a browser rather than from any gate here.

      Plan mode grounded on a seeded local Redis read 17 real key prefixes through the
      provider — the grounding worked — and then drafted `KEYS user:*` in one run and
      `ZCARD user:*` in another. Both name a key that does not exist: `user:*` is a
      GROUPING this server synthesised, by SCANning a bounded slice of the keyspace and
      collapsing everything before the first colon into one row. The model was handed
      that under a block headed "Schema inventory for this run — 17 table(s)" and read
      the sentence correctly.

      Two things are wrong and each is fixed on its own axis. The NOUN comes from the
      provider's own `ProviderLabels`, which has said "Key Pattern" all along and was
      only ever shown to the browser. And what a derived grouping IS is said once, where
      it is true, driven by a capability — because no engine fact could tell a model
      that these rows are this product's own summary of a bounded reading.
    */
    describe("a plan run on an engine whose inventory rows are groupings this server derived", () => {
      const KEY_PREFIXES: readonly TableSchema[] = [
        { name: "user:*", columns: [], indexes: [], foreignKeys: [] },
        { name: "order:*", columns: [], indexes: [], foreignKeys: [] },
      ];

      /** The sentence, in full: nothing shorter proves the three clauses all arrived. */
      const DERIVED_GROUPINGS_RULE =
        "Those key patterns are not objects this database holds, and no statement can be given one as a name: this server derived every row of that inventory itself, by scanning a bounded part of the keyspace and grouping the real key names it found under their common prefix. So name a whole key, or ask for keys by pattern in whatever way this engine offers — a row from that list is neither. And because the scan was bounded, the list is what one reading reached rather than everything this database holds.";

      const planOnKeyspace = async (
        workflowType?: AgentRunWorkflowType,
      ): Promise<{
        readonly rules: string;
        readonly transcript: string;
        readonly events: readonly AgentRunEvent[];
      }> => {
        const b = boot(freshDataDir(), { describesSchema: async () => KEY_PREFIXES });
        const run = await startRun(b, "planning", workflowType);
        const script = scriptedModel(answersProse("a plan"));

        await runInvestigation(run.runId, {
          service: b.service,
          model: await modelOver(script.fetch),
          resources: {
            ...b.resources,
            connection: { ...CONNECTION, type: "redis" },
            capabilities: {
              ...CAPABILITIES,
              queryLanguage: "json",
              declaresForeignKeys: false,
              tablesAreDerivedGroupings: true,
            },
            labels: KEY_PATTERN_LABELS,
          },
        });

        const turn = script.turns[0] as Turn;
        return { rules: rulesOf(turn), transcript: turn.transcript, events: await eventsOf(b.store, run.runId) };
      };

      test("the fenced inventory counts what this engine actually holds, and never calls them tables", async () => {
        const { transcript } = await planOnKeyspace();

        expect(transcript).toContain("2 key pattern(s) read at epoch");
        expect(transcript).not.toContain("table(s) read at epoch");
      });

      test("the run is told what a derived grouping is, and what a statement may name instead", async () => {
        const { rules } = await planOnKeyspace();

        expect(rules).toContain(DERIVED_GROUPINGS_RULE);
      });

      /*
        The one thing this sentence may NOT do. A rule banning `KEYS` would be engine
        trivia in a prompt: it goes stale, it says nothing about the next command, and a
        model that knows what the rows are can choose for itself. The owner deferred a
        per-engine knowledge base deliberately, and this is the line that keeps this
        change on the near side of it.
      */
      test("it names no command and forbids none", async () => {
        const { rules } = await planOnKeyspace();

        expect(rules).not.toContain("KEYS");
        expect(rules).not.toContain("SCAN ");
        expect(rules).not.toContain("never use");
      });

      /*
        And the LEDGER carries it, which is what the timeline reads (#414). The prompt
        half of this work left the rail saying "Schema captured — 17 tables" over the
        same keyspace the model had just been told holds key patterns. The rail cannot
        ask a provider for labels and must not ask the connection — it renders runs
        resumed long after they ran — so the capture entry records the word it was read
        under, next to the count it was read with.
      */
      test("the capture entry records what the engine calls the rows it read", async () => {
        const { events } = await planOnKeyspace();
        const captured = events.find((event) => event.kind === "context-captured");

        if (captured?.kind !== "context-captured") throw new Error("this drive captured no inventory");
        expect(captured.noun).toEqual({ singular: "key pattern", plural: "key patterns" });
        expect(captured.tableCount).toBe(2);
      });

      test("every other sentence about the inventory uses the engine's own noun too", async () => {
        const { rules, transcript } = await planOnKeyspace();

        expect(rules).toContain("Name the real key patterns, columns and relations it reads");
        expect(rules).toContain("instead of writing about key patterns in general");
        expect(transcript).toContain("the same reading this product performs when it lists your key patterns");
        expect(transcript).toContain("infers a key pattern's fields from a sample of its own rows");
        expect(transcript).toContain("Whatever relates these key patterns to each other");
      });

      /*
        The prose deliverable is the other half of the plan surface and reads the same
        inventory, so the noun and the nature of the rows have to reach it as well —
        `operations` is the workflow a user is most likely to open on a Redis connection.
      */
      test("an operations plan on the same engine is told both things too", async () => {
        const { rules, transcript } = await planOnKeyspace("operations");

        expect(rules).toContain(DERIVED_GROUPINGS_RULE);
        expect(rules).toContain("You must name no key pattern and no index that this conversation has not shown you");
        expect(transcript).toContain("2 key pattern(s) read at epoch");
      });

      /*
        And the control, because a silent change to the PostgreSQL prompt is the most
        likely damage this work could do. An engine that declares nothing new gets the
        words it always got, and never the derived-groupings sentence.
      */
      test("an engine that declares neither the noun nor the grouping is untouched", async () => {
        const b = boot(freshDataDir(), { answer: catalog });
        const run = await startRun(b, "planning");
        const script = scriptedModel(answersProse("a plan"));
        await runInvestigation(run.runId, {
          service: b.service,
          model: await modelOver(script.fetch),
          resources: b.resources,
        });

        const turn = script.turns[0] as Turn;
        expect(turn.transcript).toContain("table(s) read at epoch");
        expect(rulesOf(turn)).toContain("Name the real tables, columns and relations it reads");
        expect(rulesOf(turn)).not.toContain("are not objects this database holds");
      });
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
    The omission notice, and the tool it may name.

    A database with more tables than the packing bound holds is told how many were left
    out — a silently truncated list is a model that believes it has seen the schema —
    and until #411 that notice ended "call inspect_schema with a table selector to read
    any of them" in EVERY mode. A plan run has no tools at all, so on a large enough
    database it was already being told to call something it does not have: the #350
    failure, in the one mode that cannot recover from it by trying the call.

    The tool set belongs to the caller, so the caller says what can be done about the
    omission. Both directions are asserted, because a notice that named nothing anywhere
    would pass the plan half while quietly costing an agent run the one sentence that
    tells it how to read the rest.
  */
  describe("the omission notice names a tool the reader actually holds, or none", () => {
    /**
     * More tables than the pack can hold AND more relations than the diagram holds, so
     * both omission notices are reached rather than argued about.
     *
     * The relations half was missing when this fixture was first written, and the test
     * below passed for the wrong reason: with no foreign keys, `renderErDiagram`
     * short-circuits to its empty-read branch and its omission notice is never rendered
     * at all — so an assertion that no tool is named certified a property
     * the code did not have. Found by review on #411.
     */
    const wideCatalog = async (sql: string): Promise<QueryResult> => {
      if (sql.includes("information_schema.columns")) {
        return queryResult({
          rows: Array.from({ length: 300 }, (_, index) => ({
            table_schema: "public",
            table_name: `department_table_${index}`,
            column_name: "identifier_column",
            data_type: "character varying",
            is_nullable: "NO",
          })),
          fields: ["table_schema", "table_name", "column_name", "data_type", "is_nullable"],
          rowCount: 300,
        });
      }
      if (sql.includes("pg_constraint")) {
        return queryResult({
          rows: Array.from({ length: 299 }, (_, index) => ({
            table_schema: "public",
            table_name: `department_table_${index}`,
            column_name: "identifier_column",
            referenced_schema: "public",
            referenced_table: `department_table_${index + 1}`,
            referenced_column: "identifier_column",
          })),
          fields: [
            "table_schema",
            "table_name",
            "column_name",
            "referenced_schema",
            "referenced_table",
            "referenced_column",
          ],
          rowCount: 299,
        });
      }
      return queryResult({ rows: [], fields: [], rowCount: 0 });
    };

    const firstTurnOf = async (mode: "agent" | "planning"): Promise<string> => {
      const b = boot(freshDataDir(), { answer: wideCatalog });
      const run = await startRun(b, mode);
      const script = scriptedModel(answersProse("understood"));
      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });
      return script.turns[0]?.transcript ?? "";
    };

    test("a plan run is told what was omitted and is sent to no tool", async () => {
      const transcript = await firstTurnOf("planning");

      // Both notices, because both blocks overflow on this fixture and each has its own
      // bound: the inventory's, and the relations diagram's.
      expect(transcript).toContain("further table(s) omitted as less relevant to this task");
      expect(transcript).toContain("further relation(s) omitted.");
      expect(transcript).not.toContain("inspect_schema");
    });

    test("an agent run is told the same two things, and how to read the rest of each", async () => {
      const transcript = await firstTurnOf("agent");

      expect(transcript).toContain("further table(s) omitted as less relevant to this task");
      expect(transcript).toContain("Call inspect_schema with a table selector to read any of them.");
      expect(transcript).toContain("further relation(s) omitted.");
      // Quote-free fragment: the transcript is the JSON body, so the advice's own
      // `kind="relations"` appears with its quotes escaped.
      expect(transcript).toContain("Call inspect_schema with kind=");
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

    /*
      The prose row of the deliverable table, and the one clause of it that a live run
      refuted.

      The row itself is unchanged and is asserted as unchanged: `operations` is still
      judged as prose, still given no statement contract and still offered no refusal
      marker. What changed is a sentence that was not a deliverable at all but a
      PROHIBITION — "there is no statement to write here and no fenced block to
      produce" — resting on the premise that an operations reading is not SQL.

      Driven in a browser on 2026-08-17 against dvdrental: an Automatic plan run
      classified to Operate, grounded on 22 tables, closed with a fenced
      `pg_stat_user_indexes` read ordered by `idx_scan` and the rail offered "Apply to
      editor" on it. On PostgreSQL an operational reading very often IS an ordinary
      SELECT — `pg_stat_user_indexes`, `pg_stat_activity`, `pg_locks` — so the premise is
      false on the engine the product is demonstrated on, and a rule live runs visibly
      disobey is the #350/#356 failure class this repository tracks: the code asserts one
      thing and every run does another.
    */
    test("an operations plan is asked for prose, and welcomes a reading its engine expresses as a statement", async () => {
      const rules = await planRulesFor("operations");

      // The deliverable is untouched. It is prose, so no contract and no marker.
      expect(rules).not.toContain("Produce ONE runnable statement");
      expect(rules).not.toContain("NO STATEMENT:");
      // What a grounded one is asked for: the real objects, rather than readings in
      // the abstract.
      expect(rules).toContain("Name the real tables and indexes each reading would be about");
      // And the false clause is gone in both of its halves, because the block is the
      // half the user acts on.
      expect(rules).not.toContain("There is no statement to write here");
      expect(rules).not.toContain("no fenced block to produce");
      // What stands in its place: the block is welcome where the engine expresses the
      // reading as one, tagged so the editor hand-off is offered (#389).
      expect(rules).toContain("A reading is not always prose");
      expect(rules).toContain("fenced block tagged `postgres`");
      // Welcome is not required: an engine that expresses no reading as a statement
      // must be able to answer with none, which is the Redis and MongoDB case.
      expect(rules).toContain("a plan with no block in it is a complete answer here");
      // The bound that keeps this from becoming a fifth statement workflow.
      expect(rules).toContain("READ WHAT THE ENGINE REPORTS ABOUT ITSELF");
      expect(rules).toContain("is not an operational reading");
      // And the inventory bound survives the rewrite of the sentence it used to share.
      expect(rules).toContain("name no table and no index that this conversation has not shown you");
    });

    /*
      The engine decides it, exactly as it does for every other workflow since #411:
      `CATALOG_PLANS` serves PostgreSQL and SQLite, and on anything else an operations
      plan is ungrounded and must KNOW it — otherwise the rules that keep it from
      naming tables nobody has are resting on a flag that is not honest.
    */
    test("an operations plan on an engine this server cannot ground is told it has seen nothing", async () => {
      const b = boot(freshDataDir());
      const run = await startRun(b, "planning", "operations");
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: { ...b.resources, connection: { ...CONNECTION, type: "mongodb" } },
      });

      const rules = rulesOfTurn(script.turns[0] as Turn);
      expect(rules).toContain("No schema inventory is available to this run");
      expect(rules).toContain("the readings you would take");
      expect(rules).not.toContain("A schema inventory for this database is in this conversation");
      // The capture's own diagnosis, forwarded rather than replaced: it is the only
      // thing that knows WHY. Until #414 what it knew here was the DIALECT; now the
      // dialect only decides which of the two readings is taken, and what it knows is
      // that this connection's provider rejected the request to describe the database.
      expect(script.turns[0]?.transcript).toContain("this database refused to describe its own schema");
      // And never the capture's own ADVICE, which sends a model to a tool no operations
      // run holds in either mode (#350).
      expect(script.turns[0]?.transcript).not.toContain("Use inspect_schema");
      // The capture reaches a provider here now, but it composes no statement: the
      // dialect has no catalog and none is guessed at for it.
      expect(b.queryReadOnly).not.toHaveBeenCalled();
    });

    /*
      The ungrounded arm of the same decision, and it is a decision rather than a
      consequence: a run that has seen no inventory MAY still write out a statement over
      the engine's own reporting objects.

      The reason is what "ungrounded" actually withholds. It withholds this DATABASE —
      not one table, not one index — and it withholds nothing about the ENGINE. That a
      MySQL server has `performance_schema` or a SQL Server one has `sys.dm_exec_requests`
      is a property of the product, knowable to a run that has seen no schema at all, and
      it is knowledge this path already spends: the ungrounded rules have always asked
      for the readings it would take and the engine rule already binds them to this
      engine. Withholding the FENCE while permitting the same reading in prose would be a
      distinction with nothing behind it, and it would cost the user the editor hand-off
      on exactly the engines that have no other deliverable — MySQL, SQL Server,
      ClickHouse, and a PostgreSQL run whose catalog read was refused are all this path.

      What is still forbidden is unchanged and is asserted here: an object of the USER'S.
      `SELECT ... FROM pg_stat_activity` is permitted; the same statement filtered on
      `relname = 'rental'` is not, because this run has never been told that table exists.
    */
    test("an ungrounded operations plan may still write the engine's own reporting reading as a statement", async () => {
      const b = boot(freshDataDir());
      const run = await startRun(b, "planning", "operations");
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: { ...b.resources, connection: { ...CONNECTION, type: "mysql" } },
      });

      const rules = rulesOfTurn(script.turns[0] as Turn);
      expect(rules).toContain("No schema inventory is available to this run");
      // The same permission the grounded path carries, spelled with this connection's
      // own tag so the hand-off is offered here too.
      expect(rules).toContain("A reading is not always prose");
      expect(rules).toContain("fenced block tagged `mysql`");
      expect(rules).toContain("READ WHAT THE ENGINE REPORTS ABOUT ITSELF");
      // And the line the permission may not cross: the engine's reporting objects are
      // not this database's schema, so naming one invents nothing — naming a table of
      // the user's does.
      expect(rules).toContain("invent no table and no index names");
      expect(rules).toContain("rather than of this database's schema");
      // Still prose-deliverable, still no contract and no marker.
      expect(rules).not.toContain("Produce ONE runnable statement");
      expect(rules).not.toContain("NO STATEMENT:");
      expect(rules).not.toContain("There is no statement to write here");
      expect(rules).not.toContain("no fenced block to produce");
    });

    /*
      The other way to arrive ungrounded, and the reason the sentence is not written
      here: a catalog read that was REFUSED on an engine this server does serve.

      Until review on #411 the operations branch replaced the capture's text wholesale
      with a sentence naming the connection type, so this run was told "no inventory
      could be read on this postgres connection" — which reads as a property of
      PostgreSQL, on a deployment where every other operations run is grounded, and which
      discarded the only record of what actually went wrong. The engine's own words are
      what an operator needs, and they arrive fenced.
    */
    test("an operations plan whose catalog read is refused is told the real reason, not blamed on its engine", async () => {
      const b = boot(freshDataDir(), {
        answer: async () => {
          throw new QueryError("permission denied for view pg_class", "postgres");
        },
      });
      const run = await startRun(b, "planning", "operations");
      const script = scriptedModel(answersProse("a plan"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: b.resources,
      });

      const transcript = script.turns[0]?.transcript ?? "";
      expect(transcript).toContain("permission denied for view pg_class");
      expect(transcript).not.toContain("could be read for this run on this postgres connection");
      expect(rulesOfTurn(script.turns[0] as Turn)).toContain("No schema inventory is available to this run");
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

    /*
      WHICH ENGINE the plan is about, and why the prose deliverable is the one that was
      never told.

      Every statement plan carries its engine already: `planningStatementContract` takes
      the connection type and spends it on the fence tag, so a plan that writes SQL is
      writing it for a named dialect. The prose plan took no type at all — and
      `operations` is the only workflow whose deliverable is prose, so a plan-mode
      Operate run was the one plan run in the product that was never told which engine
      it was planning against.

      Found by driving the built branch in Chrome after #411, which is what makes it
      worth pinning here rather than reasoning about. Grounding made these plans
      SPECIFIC without making them right: a grounded plan on a SQLite connection named
      the eight real tables of the inventory and then proposed reading
      `pg_stat_user_indexes` and `pg_total_relation_size`, and an ungrounded plan on a
      Redis connection correctly said it could name no object and then proposed wait
      event statistics, lock management views and a blocking chain dependency tree.
      Redis has no locks and no wait events; SQLite has neither of those views. The
      confident half of the answer was about a different database engine.

      Naming the type is measurably not enough on its own: `planningUngroundedNote`
      already interpolates "on this redis connection" and that run still proposed lock
      trees. So the rule asserted here is about the READINGS — that a named one must be
      one this engine offers — and it is asserted on both the grounded and the
      ungrounded path, because the live defect appeared on one of each.
    */
    describe("an operations plan is told which engine its readings would come from", () => {
      /**
       * A SQLite catalog, keyed the way `composed-sql.ts` composes it.
       *
       * The statistics probe answers with NO ROW, which on this engine means the
       * database has never been analysed rather than that anything failed — so this
       * fixture also holds the grounded-without-statistics arm, which is the arm a real
       * SQLite file most often presents.
       */
      const sqliteCatalog = async (sql: string): Promise<QueryResult> => {
        if (sql.includes("type IN ('table', 'view')")) {
          return queryResult({
            rows: [{ name: "payment", type: "table", sql: "CREATE TABLE payment (amount NUMERIC)" }],
            fields: ["name", "type", "sql"],
            rowCount: 1,
          });
        }
        if (sql.includes("type = 'index'")) {
          return queryResult({
            rows: [
              {
                name: "idx_payment_amount",
                tbl_name: "payment",
                sql: "CREATE INDEX idx_payment_amount ON payment (amount)",
              },
            ],
            fields: ["name", "tbl_name", "sql"],
            rowCount: 1,
          });
        }
        return queryResult({ rows: [], fields: [], rowCount: 0 });
      };

      /** The rules of an operations plan opened on one engine, with that engine's catalog. */
      const operationsPlanRulesOn = async (
        type: DatabaseType,
        options: BootOptions = {},
      ): Promise<{ readonly rules: string; readonly transcript: string }> => {
        const b = boot(freshDataDir(), options);
        const run = await startRun(b, "planning", "operations");
        const script = scriptedModel(answersProse("a plan"));

        await runInvestigation(run.runId, {
          service: b.service,
          model: await modelOver(script.fetch),
          resources: { ...b.resources, connection: { ...CONNECTION, type } },
        });

        const turn = script.turns[0] as Turn;
        return { rules: rulesOfTurn(turn), transcript: turn.transcript };
      };

      test("a grounded operations plan on SQLite may name only readings SQLite offers", async () => {
        const { rules } = await operationsPlanRulesOn("sqlite", { answer: sqliteCatalog });

        // Grounded, so this is the arm that produced the live defect: it names the real
        // tables AND the wrong engine's views.
        expect(rules).toContain("A schema inventory for this database is in this conversation");
        expect(rules).toContain("This database is sqlite and nothing else");
        expect(rules).toContain("every reading you name must be one a sqlite engine actually offers");
        // The constraint has to bite on the readings rather than on the engine's name,
        // because naming the engine alone is what was already happening.
        expect(rules).toContain("belongs to a different engine");
        // And it may not become a tool the mode does not have (#350): a plan run holds
        // none at all, so a sentence about readings must not imply one can be taken.
        expect(rules).not.toContain("inspect_operations");
      });

      /*
        The same rule on the other grounded engine, so the type is spliced from the
        connection rather than written into the sentence. A rule that said "sqlite" for
        every engine would pass the test above and be worse than saying nothing.
      */
      test("the same plan on PostgreSQL names PostgreSQL, and no other engine", async () => {
        const { rules } = await operationsPlanRulesOn("postgres");

        expect(rules).toContain("This database is postgres and nothing else");
        expect(rules).toContain("every reading you name must be one a postgres engine actually offers");
        expect(rules).not.toContain("sqlite");
      });

      /*
        The ungrounded arm, and the one the live Redis run failed. A run that has seen no
        inventory is MORE exposed to this, not less: it has no real object to be
        specific about, so everything it can be specific about is the mechanism it names.
      */
      test("an ungrounded operations plan on Redis is told the engine as well as that it saw nothing", async () => {
        const { rules, transcript } = await operationsPlanRulesOn("redis");

        expect(rules).toContain("No schema inventory is available to this run");
        expect(rules).toContain("This database is redis and nothing else");
        expect(rules).toContain("every reading you name must be one a redis engine actually offers");
        expect(rules).not.toContain("inspect_operations");
        // The capture's own diagnosis still reaches the model, unchanged by this rule.
        // It names the reading rather than the dialect since #414: Redis takes the
        // provider path now, and this fixture's `getSchema()` rejects.
        expect(transcript).toContain("this database refused to describe its own schema");
      });

      /*
        And the four workflows that write a statement are left alone. Their engine is
        already carried by the fence tag, which is a claim the reader checks (#396); a
        second sentence about the same engine would be a second place to keep it true.
      */
      test("a plan whose deliverable is a statement is not given the readings rule", async () => {
        const rules = await planRulesFor("investigation");

        expect(rules).toContain("fenced block tagged `postgres`");
        expect(rules).not.toContain("This database is postgres and nothing else");
        expect(rules).not.toContain("actually offers");
        // Nor the prose deliverable's optional-block rule. Their block is REQUIRED and
        // is the deliverable; a sentence saying one is welcome would be a second and
        // weaker statement of a contract they already carry.
        expect(rules).not.toContain("A reading is not always prose");
        expect(rules).not.toContain("READ WHAT THE ENGINE REPORTS ABOUT ITSELF");
      });
    });
  });

  /*
    Item 5 of the same design: the statement a plan run drafts becomes a FACT on the
    ledger rather than something the browser parses back out of markdown.

    It mattered because the ledger is the only thing that outlives the drive. #389's
    "Apply to editor" control reads SQL out of a fence in the browser — it works when
    the model fences its SQL and silently offers nothing when it does not — so plan
    mode's entire deliverable was recorded nowhere and could be checked by nothing
    at all.

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

    /*
      `language` is separate from `type` because the two are separate facts and this
      suite's fixture proves it: overriding the connection's type to `mongodb` leaves
      `CAPABILITIES.queryLanguage` at `"sql"`, so a test that only swaps the type is
      still driving a SQL-speaking engine. What decides whether the validation judges a
      draft is the capability the provider declares, never the type-id (#414).
    */
    const planWith = async (
      closing: string,
      options: {
        readonly workflowType?: AgentRunWorkflowType;
        readonly type?: DatabaseType;
        readonly language?: ProviderCapabilities["queryLanguage"];
      } = {},
    ): Promise<readonly AgentRunEvent[]> => {
      const b = boot(freshDataDir(), { answer: catalog });
      const run = await startRun(b, "planning", options.workflowType);
      const script = scriptedModel(answersProse(closing));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: {
          ...b.resources,
          ...(options.type === undefined ? {} : { connection: { ...CONNECTION, type: options.type } }),
          ...(options.language === undefined
            ? {}
            : { capabilities: { ...CAPABILITIES, queryLanguage: options.language } }),
        },
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

      // The type is `mongodb` and the CAPABILITIES are still SQL's, which is what makes
      // this the no-inventory case rather than #414's: the validation asks the
      // provider's declared language, so this run is a SQL engine with no inventory.
      expect(drafted).toMatchObject({
        dialect: "mongodb",
        guardApplicable: true,
        identifiers: { kind: "no-inventory" },
      });
    });

    /*
      #414. Both halves of the validation are SQL readers, and grounding plan mode on
      the engines that speak no SQL made both of them wrong at once on a correct draft:
      the guard marks every Mongo aggregation `NON_READ_STATEMENT` on its leading word,
      and the identifier check finds no table keyword in one and would therefore report
      that every table it names exists. So it declines to judge, and the entry says
      which check could not reach the draft rather than what it found.
    */
    test("a draft on an engine whose statements are not SQL is recorded as unjudged, not as an objection", async () => {
      const aggregation = 'db.orders.aggregate([{ $group: { _id: "$customerId", n: { $sum: 1 } } }])';
      const drafted = draftedIn(await planWith(fenced(aggregation, "mongodb"), { type: "mongodb", language: "json" }));

      expect(drafted).toMatchObject({
        dialect: "mongodb",
        sql: aggregation,
        guardApplicable: false,
        // `false`, because a guard that read nothing established nothing — and no
        // reason code, because there was no objection to record.
        readOnly: false,
        identifiers: { kind: "not-applicable" },
      });
      expect(drafted).not.toHaveProperty("guardViolation");
      // Still recorded, and still the run's deliverable: declining to judge a draft is
      // not declining to keep it.
      expect(kindsOf(await planWith(fenced(aggregation, "mongodb"), { type: "mongodb", language: "json" }))).toContain(
        "plan-statement-drafted",
      );
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

describe("a run that stops having read nothing is told to read it itself", () => {
  /*
    A distinct loss from the one below, and the reminder there cannot reach it: that notice
    is for a run that CALLED its tools and then narrated, and it is gated on exactly that
    (`if (!anyToolCalled) return false`). The run measured here called nothing at all. It
    read the objective, stopped after ten seconds, and asked the user for the statement it
    had been sent to diagnose — while holding the instruments that would have found it.

    Free to retry, and that is why it may exist. `compose_report` is itself one of the run's
    tools, so a run that called nothing composed no report and its verdict is already
    `no-report`. The extra turn is spent on a run that has lost; it cannot turn a pass into
    a failure, only a failure into another attempt.

    Per-model all the same, and off by default: the ten models locked at 300/300 were
    measured without it, and a drive-wide change is how this repository has twice handed
    back cells it had already won.
  */
  const asksTheUser = answersProse("Could you please share the exact SQL statement you are running?");

  test("the model is told which instrument to call, and gets the turn back", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(asksTheUser, answersProse("Understood."));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch, "https://api.openai.com/v1", "nemotron3:33b"),
      resources: b.resources,
    });

    expect(script.turns.length).toBe(2);
    // Names the instrument, not the rule: the measured defect class here is a model told
    // WHAT it did wrong and never WHAT to call instead.
    expect(script.turns[1]?.transcript).toContain("inspect_schema");
  });

  test("a model that was not measured needing it is left alone", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(asksTheUser, answersProse("Understood."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(script.turns.length).toBe(1);
    expect(result.stopReason).toBe("model-stopped");
  });

  test("an operations run is not told to call the two instruments it does not hold", async () => {
    /*
      The sentence NAMES `inspect_schema` and `inspect_plan`, and `operations` is the one agent
      set built on a different three - `inspect_operations`, `recommend_change`,
      `compose_report` - because the read-class tools need `queryReadOnly`, which only two
      providers implement.

      So the retry is gated on the run actually holding what the sentence names. Told to call a
      tool it has not got, a run calls it, is answered "there is no such tool", and spends the
      very turn this retry bought: the #350/#356 defect, already paid for once. The three tests
      above use the default workflow, which is the one where the sentence happens to be true.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "operations");
    const script = scriptedModel(asksTheUser, answersProse("Understood."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch, "https://api.openai.com/v1", "nemotron3:33b"),
      resources: b.resources,
    });

    expect(script.turns.length).toBe(1);
    expect(result.stopReason).toBe("model-stopped");
  });

  test("an EMPTY stopping turn spends it too, so this switch subsumes retryEmptyTurn", async () => {
    /*
      The gate asks whether anything was CALLED, not what was said, so a turn with no text at
      all reaches it as well as the question this was measured on. `nemotron3:33b` records
      `retryEmptyTurn: false` and its empty turns are asked again regardless - pinned here
      because it is the behaviour, not the wording, that a reader of the entry would get wrong.

      Not narrowed to a non-empty turn, which is the obvious repair: that would change what the
      five passing runs were measured under, and a measured cell does not move without being
      re-measured. Recorded in `docs/BACKLOG.md` instead.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse(""), answersProse("Understood."));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch, "https://api.openai.com/v1", "nemotron3:33b"),
      resources: b.resources,
    });

    expect(script.turns.length).toBe(2);
    expect(script.turns[1]?.transcript).toContain("inspect_schema");
  });

  test("it is spent once, so a run that stops again is not asked a third time", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(asksTheUser, asksTheUser, answersProse("Understood."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch, "https://api.openai.com/v1", "nemotron3:33b"),
      resources: b.resources,
    });

    expect(script.turns.length).toBe(2);
    expect(result.stopReason).toBe("model-stopped");
  });
});

describe("a run that used its tools and then narrated is reminded once", () => {
  /*
    The `no-report` shortfall, measured on three models: each called this run's tools,
    established something, and then wrote its findings as prose. A prose turn ends the
    run, so the readings were thrown away and the verdict read `no-report`.

    What the reminder may NOT do is as load-bearing as what it does. It names
    `compose_report`, so it may only reach a run that holds that tool; and it costs a
    turn, so it may only be sent where a turn remains.
  */
  const invents = (): Response => chatToolCallStream("no_such_tool", JSON.stringify({}), "call_invented");

  test("a planning run that reaches for a tool is never told to call one", async () => {
    // Planning mode holds NO tools at all, so a reminder naming `compose_report` would
    // be a rule this run's tool set cannot satisfy (#350/#356). The refusal a run gets
    // for reaching outside its set is not evidence that it used one.
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(callsTool("run_read_query", { sql: "SELECT 1" }), answersProse("understood"));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const sent = script.turns.flatMap((turn) => JSON.stringify(turn.body.messages ?? []));
    expect(sent.some((messages) => messages.includes("compose_report"))).toBe(false);
    expect(result.stopReason).toBe("model-stopped");
  });

  test("a name the model invented is not a tool this run used", async () => {
    // The sentence says this run CALLED its tools. A name that matched nothing reached
    // nothing, so a run reminded on one would be told something untrue about itself and
    // then told to cite artifacts it has not got.
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(invents, answersProse("I could not do that."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(script.turns[1]?.transcript).toContain("There is no tool called");
    const sent = script.turns.flatMap((turn) => JSON.stringify(turn.body.messages ?? []));
    expect(sent.some((messages) => messages.includes("written your findings as prose"))).toBe(false);
    expect(result.stopReason).toBe("model-stopped");
  });

  test("a run that narrates on its last allowed turn keeps its own ending", async () => {
    // The ceiling is exactly where this happens: `AGENT_REPORT_RESERVE_NOTICE` has
    // already told the model to wrap up two turns earlier, and a small model wraps up
    // in prose. A reminder sent into a turn the loop will not grant does not rescue the
    // run — it rewrites a model that stopped as a run that ran out of turns.
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "read it" }),
      answersProse("Orders were read."),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
      maxTurns: 2,
    });

    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("model-stopped");
  });

  test("a run with a turn left is reminded, and reports on it", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "read it" }),
      answersProse("Orders were read."),
      reportOn("Orders were read."),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.stopReason).toBe("report-composed");
    const sent = script.turns.flatMap((turn) => JSON.stringify(turn.body.messages ?? []));
    expect(sent.some((messages) => messages.includes("written your findings as prose"))).toBe(true);
    expect((await eventsOf(b.store, run.runId)).map((event) => event.kind)).toContain("report-composed");
  });

  /*
    Once per RUN and not once per drive (B51).

    Every notice bound was a `let` inside `runInvestigation` — which is also what RESUMES a
    run a dead process left running — so a resumed drive started with every flag false and
    could deliver a notice the previous drive had already delivered. Nothing durable bounded
    them, because a delivery wrote no ledger entry at all: `docs/llms/` is built by reading
    run ledgers, and its whole claim is that each figure comes from an observed run, so an
    unattributable rescue is worse than an unrecorded one.

    Driven as two drives over one data directory, which is what a resume is in this suite.
    The first drive dies where the loop cannot decide (a 401 leaves the run running), so
    the second is a genuine resume with its own counters.
  */
  test("a resumed drive is not told to report again, because the delivery is on the ledger", async () => {
    const dataDir = freshDataDir();
    const first = boot(dataDir);
    const run = await startRun(first);
    const firstScript = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "read it" }),
      // Prose after a tool call, which is what earns the reminder — and the turn is taken
      // again, so the third scripted answer is what the reminded turn gets.
      answersProse("Orders were read."),
      () => endpointError(401, "invalid api key"),
    );

    await expect(
      runInvestigation(run.runId, {
        service: first.service,
        model: await modelOver(firstScript.fetch),
        resources: first.resources,
      }),
    ).rejects.toBeInstanceOf(LLMAuthError);
    const delivered = guidanceDelivered(await eventsOf(first.store, run.runId));
    expect(delivered["report-reminder"]).toBe(1);

    // A second process over the same ledger. It calls a tool of its own, so `anyToolCalled`
    // is true here too and the only thing standing between it and a second reminder is what
    // the ledger says.
    const second = boot(dataDir);
    const secondScript = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM customers", rationale: "read it" }, "call_2"),
      answersProse("Customers were read."),
    );

    const result = await runInvestigation(run.runId, {
      service: second.service,
      model: await modelOver(secondScript.fetch),
      resources: second.resources,
    });

    // Two turns and not three: the run narrated and stopped, un-nudged.
    expect(result.turns).toBe(2);
    expect(guidanceDelivered(await eventsOf(second.store, run.runId))["report-reminder"]).toBe(1);
    const sent = secondScript.turns.flatMap((turn) => JSON.stringify(turn.body.messages ?? []));
    expect(sent.some((messages) => messages.includes("written your findings as prose"))).toBe(false);
  });

  test("a delivery records where in the run it landed, not only that it happened", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "read it" }),
      answersProse("Orders were read."),
      reportOn("Orders were read."),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const issued = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "guidance-issued");
    expect(issued?.notice).toBe("report-reminder");
    // The reminder rides the SECOND turn, after one tool call: a nudge on the second turn
    // and one on the last are different facts about a model, and the ledger could say
    // neither.
    expect(issued?.atTurn).toBe(2);
    expect(issued?.toolCalls).toBe(1);
  });

  test("the reminder is sent once, so a model that narrates again still stops", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "read it" }),
      answersProse("Orders were read."),
      answersProse("Orders were read."),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.stopReason).toBe("model-stopped");
    expect(result.turns).toBe(3);
  });
});

/*
  The fold that makes "once" mean once (B51).

  Driven directly as well as through a drive, because what it has to get right is a reading
  of two DIFFERENT entry kinds: a notice sent as a `user` message writes `guidance-issued`,
  and one sent instead of running a call is the `notice` on that call's hold.
*/
describe("guidanceDelivered", () => {
  const at = (event: AgentRunEvent): AgentRunEvent => event;

  test("counts both entry kinds, because a delivery lands on whichever records the call", () => {
    const counts = guidanceDelivered([
      at({ kind: "guidance-issued", atMs: 1, notice: "report-reminder" }),
      at({ kind: "guidance-issued", atMs: 2, notice: "report-reminder", atTurn: 4, toolCalls: 2 }),
      at({ kind: "call-held", atMs: 3, tool: "compose_report", reason: "cite it", notice: "cite-what-you-read" }),
    ]);

    expect(counts["report-reminder"]).toBe(2);
    expect(counts["cite-what-you-read"]).toBe(1);
    // Every id is answered, and a notice nobody delivered is a zero it measured: the
    // record is total, so a new id cannot read as "never delivered" by being absent.
    expect(counts["report-reserve"]).toBe(0);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  test("a hold carrying no notice counts towards nothing, which is what it says", () => {
    // A verdict-preview hold speaks for a `shortfall` rather than for a named notice, and
    // so does every hold written before the field existed. Counting it as one would bound
    // a notice nobody sent.
    const counts = guidanceDelivered([
      at({ kind: "call-held", atMs: 1, tool: "compose_report", reason: "profile a table", shortfall: "no-report" }),
      at({ kind: "context-captured", atMs: 2, fingerprint: "ctx_1", tableCount: 1 }),
    ]);

    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
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
      // Reminded once after a reading, the model narrates again rather than reporting.
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
    expect(catalogStatements(b)[1]).toContain("pg_constraint");
    expect(catalogStatements(b)[2]).toContain("pg_index");
    expect(b.acquireProvider).toHaveBeenCalledTimes(CONTEXT_READS);
    /*
      "Before the first turn" as an ORDER rather than an index. This read `kinds[1]`, which said
      the same thing only for as long as exactly one event preceded it — and the day another
      opening record was added the assertion failed while the property it names still held.

      The property is that nothing the model did comes first: the inventory is captured, and only
      then does the run have anything to say. Asserted against every event that represents model
      activity rather than against a position, so a new opening record cannot break it and a
      capture that genuinely slipped past the first turn cannot pass.
    */
    const kinds = kindsOf(await eventsOf(b.store, run.runId));
    const captured = kinds.indexOf("context-captured");
    expect(captured).toBeGreaterThan(-1);
    for (const activity of ["tool-invoked", "statement-drafted", "closing-statement", "report-composed"]) {
      const at = kinds.indexOf(activity);
      if (at !== -1) expect(captured).toBeLessThan(at);
    }
  });

  /*
    What the capture SPENT, on the entry (B13).

    Its reads reach `executeAuditedOperation` through `captureContextSnapshot` and never
    through `runStep`, the only writer of `tool-completed` — so the whole cost of
    grounding a run was charged against the ceilings the rail displays and folded to
    nothing: a drive with no reusable snapshot showed "0 statements" with three already
    spent, before the model's first turn.
  */
  test("the capture records the statements the tracker charged it, and not a count of its plan", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("understood"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const captured = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "context-captured");
    expect(captured?.charged?.statements).toBe(CONTEXT_READS);
    // And the entry is the only place that figure survives: the run has ended, so
    // `releaseExecutionRun` has dropped its accounting and the tracker now answers zero
    // for it. Reading the meter from the tracker instead of the ledger is the alternative
    // B13 records as not a drop-in, and this is why.
    expect(b.resources.tracker.usage(run.runId).executedStatements).toBe(0);
  });

  test("a capture that was REFUSED records what it paid anyway", async () => {
    // The engine refuses the third read, so two answered and one did not — and all three
    // were admitted and charged before the refusal was known.
    const b = boot(freshDataDir(), {
      answer: async (sql: string) => {
        if (sql.includes("pg_index")) throw new QueryError("permission denied for relation pg_index");
        return queryResult();
      },
    });
    const run = await startRun(b);
    const script = scriptedModel(answersProse("understood"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const refused = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "context-unavailable");
    expect(refused?.reasonCode).toBe("CATALOG_READ_REFUSED");
    expect(refused?.charged?.statements).toBe(CONTEXT_READS);
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

describe("a run that would report an answer it never presented", () => {
  /*
    The `no-answer` shortfall, measured on three models: each read the data, got a
    result, and went straight to `compose_report`. The report lands with nothing
    beside it and the verifier scores the run as having answered nothing.

    The notice is delivered INSTEAD of that call — `compose_report` ends the run, so
    a message after it arrives too late — and the run then has the turn it needs.
  */
  const presentsRead =
    (callId = "call_answer") =>
    (turn: Turn): Response =>
      chatToolCallStream(
        "present_answer",
        JSON.stringify({ artifact: correlationIdIn(turn.transcript), presentation: { kind: "table" } }),
        callId,
      );

  test("its compose_report is not run, and the answer it then presents is on the ledger", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "the question, in SQL" }),
      // Reports without presenting: this call is the one that gets intercepted.
      reportOn("Orders were read."),
      presentsRead(),
      reportOn("Orders were read."),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.status).toBe("succeeded");
    const kinds = (await eventsOf(b.store, run.runId)).map((event) => event.kind);
    expect(kinds).toContain("answer-composed");
    // One report on the ledger, not two: the intercepted call never reached the tool.
    expect(kinds.filter((kind) => kind === "report-composed")).toHaveLength(1);
    // And the answer was recorded BEFORE the report, which is the ordering the
    // shortfall is about.
    expect(kinds.indexOf("answer-composed")).toBeLessThan(kinds.indexOf("report-composed"));
  });

  /*
    The hold's own entry says WHICH notice it answered with (B51).

    A held delivery has always written `call-held`, so this one was never invisible — what
    it lacked was a name. `reason` is the prose the model was sent and names artifact ids in
    two of the three cases, so a resumed drive reading it back to decide whether a notice
    had already been delivered would be pattern-matching a paragraph.
  */
  test("the hold records which notice it answered with, in the vocabulary every delivery shares", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "the question, in SQL" }),
      reportOn("Orders were read."),
      presentsRead(),
      reportOn("Orders were read."),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const events = await eventsOf(b.store, run.runId);
    const held = events.find((event) => event.kind === "call-held");
    expect(held?.tool).toBe("compose_report");
    expect(held?.notice).toBe("present-before-report");
    // And the same fold that bounds a `user`-message notice across a resume counts this
    // one, which is the whole reason the id is on the hold rather than in a second entry.
    expect(guidanceDelivered(events)["present-before-report"]).toBe(1);
  });

  test("the notice is sent once, so a model that ignores it still reports", async () => {
    // The one-shot matters: without it a model that never presents would have every
    // report intercepted and the run would spend its turns rather than ending.
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "the question, in SQL" }),
      reportOn("Orders were read."),
      reportOn("Orders were read."),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.stopReason).toBe("report-composed");
    const kinds = (await eventsOf(b.store, run.runId)).map((event) => event.kind);
    expect(kinds).not.toContain("answer-composed");
    expect(kinds.filter((kind) => kind === "report-composed")).toHaveLength(1);
  });

  test("a run with no reading to present is never told to present one", async () => {
    // The guard the earlier attempt at this fix lacked: told to present when nothing
    // has been read, a run can neither present nor report, and loops to `no-report`
    // instead — which the repository's own data-analysis eval caught. So a run whose
    // ledger holds no completed read must never see the notice at all.
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    // Cites the schema snapshot rather than a result, which is what a run with no
    // reading has: `reportOn` looks for an artifact reference and there is none.
    const reportsWithoutReading = (): Response =>
      chatToolCallStream(
        "compose_report",
        JSON.stringify({ claims: [{ claim: "Nothing was read.", evidence: [{ source: "schema" }] }] }),
        "call_report",
      );
    const script = scriptedModel(reportsWithoutReading, answersProse("done"), answersProse("done"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const sent = script.turns.flatMap((turn) => JSON.stringify(turn.body.messages ?? []));
    expect(sent.some((messages) => messages.includes("This run answers by PRESENTING"))).toBe(false);
  });

  test("a catalog read is not a result this run can present, so it is never told to", async () => {
    /*
      The same guard, on the reading that looks like one and is not. `inspect_schema`
      reads the catalog under the SAME operation id a drafted read uses, so a run that
      inspected the schema and nothing else has `sql.query.read` on its ledger — and
      `present_answer` will refuse every artifact it holds, because the statement behind
      a catalog read is the SERVER's and there is nothing of the model's to hand over.
      Told to present one, such a run neither presents nor reports.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis", true);
    const script = scriptedModel(
      callsTool("inspect_schema", { schema: "public" }),
      reportOn("The schema was inspected."),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const events = await eventsOf(b.store, run.runId);
    // The reading is on the ledger under the answer's own operation id, which is what
    // makes this case the trap rather than a run with an empty ledger.
    expect(
      events.some((event) => event.kind === "tool-completed" && event.artifact.operationId === "sql.query.read"),
    ).toBe(true);
    const sent = script.turns.flatMap((turn) => JSON.stringify(turn.body.messages ?? []));
    expect(sent.some((messages) => messages.includes("This run answers by PRESENTING"))).toBe(false);
    // Nor anything else. A sentence for exactly this shape was written and measured on the
    // three models that reach it — a catalog-only read, every statement refused, no call at all
    // — and none recovered, so it was deleted rather than kept switched off.
    // And the report it did compose was composed, not intercepted.
    expect(events.map((event) => event.kind)).toContain("report-composed");
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
      // Reminded once after a reading, the model narrates again rather than reporting.
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
      // Reminded once after a reading, the model narrates again rather than reporting.
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
      // Reminded once that a run reports by CALLING compose_report, this model
      // narrates again: the answer is what this case is about, and it is already on
      // the ledger by then.
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

/*
  #414's own bound, and the one invariant whose whole point is that this change did NOT
  widen agent mode.

  Grounding reached the twelve type-ids the read-only profile refuses, because the schema
  capture asks for `agent-operations` — a profile whose acquisition does not require
  `queryReadOnly`. Agent mode's TOOLS are unchanged: `inspect_schema` and
  `run_read_query` compose SQL and acquire `agent-read-only`, which those engines cannot
  serve, so a schema-workflow agent run on one of them still stops at its first read.

  What changed is that it now gets FURTHER before stopping: it acquires a provider,
  spends a statement of its budget on a `db.schema.read`, records a `context-captured`
  event and takes a model turn, and only then is refused. That sequence is exactly what
  a future "fix" would be tempted to simplify away, and until now nothing pinned it —
  the only `engine-unsupported` test injects the error from `resolveConnection`, before
  grounding happens at all.
*/
describe("agent mode is no wider than it was, on an engine grounding now reaches", () => {
  const column = (name: string): ColumnSchema => ({ name, type: "string", nullable: true, isPrimary: false });

  test("a schema workflow is grounded and still refused at its first read", async () => {
    // The acquisition the CAPTURE makes is granted — it asks for `agent-operations`,
    // and MongoDB serves it. Every acquisition after it is the tool path asking for
    // `agent-read-only`, which is what `factory.ts` refuses on a provider with no
    // `queryReadOnly`. One fixture, both real behaviours, in the order a live run meets
    // them.
    let acquisitions = 0;
    const b = boot(freshDataDir(), {
      describesSchema: async () => [{ name: "orders", columns: [column("customerId")], indexes: [], foreignKeys: [] }],
      acquireFails: () =>
        ++acquisitions > 1
          ? new ExecutionProfileError(
              'Provider type "mongodb" has no database-native read-only execution profile',
              "PROFILE_UNSUPPORTED_BY_PROVIDER",
            )
          : undefined,
    });
    const run = await startRun(b, "agent");
    const script = scriptedModel(
      // `run_read_query` rather than `inspect_schema`: both are refused, but for
      // different reasons and only this one reaches the profile. `inspect_schema`
      // composes a catalog statement per dialect and there is none for MongoDB, so it
      // is refused before a provider is asked for. The statement tool is where a
      // schema-workflow agent run really meets the engine limit.
      callsTool("run_read_query", { sql: "SELECT 1", rationale: "size the collection" }),
    );

    await expect(
      runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch),
        resources: {
          ...b.resources,
          connection: { ...CONNECTION, type: "mongodb" },
          capabilities: { ...CAPABILITIES, queryLanguage: "json", declaresForeignKeys: false },
        },
      }),
    ).rejects.toThrow(ExecutionProfileError);

    const events = await eventsOf(b.store, run.runId);
    // Grounding DID happen — this is the half #414 added, and the half that makes the
    // refusal below worth pinning rather than obvious.
    expect(kindsOf(events)).toContain("context-captured");
    expect(script.turns[0]?.transcript).toContain("orders");
    // And the run stopped at the model's first read, having composed no statement: the
    // profile is refused before a provider exists to send one to.
    expect(invocationsOf(events)).toHaveLength(1);
    expect(b.queryReadOnly).not.toHaveBeenCalled();
    // `runtime.ts` is what turns that error into a terminal reason, and the reason it
    // gives an `ExecutionProfileError` is `engine-unsupported` — pinned where the
    // classifier lives, in `tests/isolated/agent-runtime.test.ts`.
  });
});

describe("a run that will not record what it read is narrowed to what would finish it", () => {
  /*
    The largest single loss in the whole measurement, and the reason this is a mechanism
    rather than another sentence.

    Across 25 models on six surfaces, 66 cells failed and `no-report` is 37 of them —
    more than the other ten shortfalls combined, and the only one that appears on every
    surface. It is not a run that ran out of room: those runs ended `model-stopped`,
    holding every tool they needed, having taken their readings and recorded nothing.
    `AGENT_REPORT_REMINDER_NOTICE` already tells them to report, and what they did next
    is why a notice is not enough — reminded and still holding the whole set, they went
    back to reading, repeated a refused selector, or wrote strategy about varying one.

    So the reminded turn narrows the choice instead of repeating the instruction.

    WHAT IT NARROWS TO is the part measured today rather than carried over. An earlier
    version left `compose_report` alone, and this measurement shows what that costs: the
    assessment verifier requires a `table-profiled` event and the optimization verifier a
    plan comparison, so a run narrowed to the report alone on those surfaces cannot clear
    its own bar — it would trade `no-report` for `no-table-profile`, which is a different
    failure and not a smaller one. The narrowed set is therefore the report PLUS whatever
    that workflow's verdict requires, which turns the mechanism from a muzzle into a
    funnel: the run can only do the two or three things it is judged on.
  */
  const reads = () => callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "again" });

  const namedIn = (script: { turns: { body: { tools?: unknown } }[] }, turn: number): string[] =>
    ((script.turns[turn]?.body.tools ?? []) as { function?: { name?: string } }[]).map(
      (entry) => entry.function?.name ?? "",
    );

  test("after twelve calls with nothing recorded, an investigation is left the report", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(...Array.from({ length: 13 }, reads), answersProse("still reading"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(namedIn(script, 12)).toEqual(["compose_report"]);
  });

  test("a run under the threshold keeps every tool, so ordinary work is untouched", async () => {
    // The threshold is read off the distribution, not chosen: across 43 answered runs
    // the most tool calls any made was SIX, while the runs that read themselves out went
    // to 7, 9, 11, 20 and 57. Twelve is double a healthy run's observed ceiling.
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(...Array.from({ length: 6 }, reads), reportOn("Orders were read."));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(namedIn(script, 5)).toContain("run_read_query");
  });

  test("the turn after the reminder is narrowed too, since silence is the other half", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "the question, in SQL" }),
      answersProse("Orders look fine to me."),
      answersProse("still nothing"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(namedIn(script, 2)).toEqual(["compose_report"]);
    // And the turns before it held everything, so nothing was taken away early.
    expect(namedIn(script, 0)).toContain("run_read_query");
  });

  test("a run that took no readings is not narrowed, because it has nothing to report yet", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(answersProse("I will not be reading anything today."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(result.stopReason).toBe("model-stopped");
    expect(namedIn(script, 0)).toContain("run_read_query");
  });

  test("an assessment keeps profile_table, because its verdict cannot be cleared without one", async () => {
    // The measured conflict, pinned. `verifyDatabaseAssessmentGoal` requires a
    // `table-profiled` event, so narrowing this workflow to the report alone would make
    // its own bar unreachable — and this run has not profiled anything yet.
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "database-assessment");
    const script = scriptedModel(...Array.from({ length: 13 }, reads), answersProse("still reading"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(namedIn(script, 12).sort()).toEqual(["compose_report", "profile_table"]);
  });

  test("a prompted run is told the set shrank, so it is not offered tools it may no longer call", async () => {
    /*
      The bug this pins, found by audit and confirmed in code.

      A prompted run cannot emit `tool_calls`, so the tools are declared to it as PROSE: one
      contract message, built once from the full selection and pushed before the loop. When
      narrowing fires, the native path re-declares the smaller set to the SDK — but the
      prompted path passes `undefined` and leaves the original contract standing, while
      `handleCall` enforces the narrowed set regardless of protocol.

      So a narrowed prompted run reads a contract listing `run_read_query`, calls it, and is
      answered "There is no tool called run_read_query in this run." Every such
      distill takes this path; between the four of them they lock 2 cells out of 24.

      The fix re-declares the contract at the moment of narrowing, which is the same thing
      the native path gets for free by handing the SDK a smaller set.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "database-assessment", undefined, "prompted");
    // Driven in the protocol this run actually speaks: a prompted call is a JSON object in
    // ordinary text, and a native `tool_calls` reply would leave the SDK waiting for a tool
    // result this path never writes. Narrowing is tripped by the report reminder rather than
    // by the twelve-call ceiling, which is the same `narrowed = true` two turns sooner.
    const promptedCall = (name: string, args: Record<string, unknown>) =>
      answersProse(JSON.stringify({ action: name, arguments: args }));
    const script = scriptedModel(
      promptedCall("profile_table", { table: "orders" }),
      answersProse("The orders table looks fine to me."),
      answersProse("Nothing further."),
      answersProse("Done."),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // The turn after narrowing must carry a contract that no longer offers the reading tools,
    // and must still offer the two the verdict accepts.
    const afterNarrowing = promptText(script.turns[2] as Turn);
    expect(afterNarrowing).toContain("profile_table");
    expect(afterNarrowing).toContain("compose_report");
    expect(afterNarrowing.slice(afterNarrowing.lastIndexOf("profile_table"))).not.toContain("run_read_query");
  });

  test("an optimization keeps both instruments its verdict accepts", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "query-optimization");
    const script = scriptedModel(...Array.from({ length: 13 }, reads), answersProse("still reading"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(namedIn(script, 12).sort()).toEqual(["compare_plans", "compose_report", "recommend_change"]);
  });

  test("an analysis keeps present_answer, which is the half its verdict scores separately", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "data-analysis");
    const script = scriptedModel(...Array.from({ length: 13 }, reads), answersProse("still reading"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(namedIn(script, 12).sort()).toEqual(["compose_report", "present_answer"]);
  });

  test("an instrument a narrowed run has already used three times is dropped too", async () => {
    /*
      The loop the narrowing did not close, and it only became visible once the tool worked.

      One evaluated model on query-optimization was refused `recommend_change` thirty-six times
      in a run, on a field the refusal did not name. Once it did, the same cell recorded
      THIRTY-THREE recommendations and still scored `no-report`: the ceiling fired, the run
      narrowed, and the narrowed set keeps this surface's instruments so its bar stays
      reachable — so the model had `recommend_change` and used it until the deadline.

      Three, because a bar can want a particular shape: this one needs a recommendation
      citing a plan, and a run that has misjudged that deserves another go rather than one
      chance. Past three it is repeating, not aiming, and only `compose_report` is left. No
      locked cell records more than two of these, so nothing measured passes through here.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "query-optimization");
    // Cites a result the run really produced, read out of the transcript the way the
    // optimization eval's helper does: a refused recommendation records nothing, and what
    // this test is about is what a RECORDED one costs.
    const recommends =
      () =>
      (turn: Turn): Response =>
        chatToolCallStream(
          "recommend_change",
          JSON.stringify({
            change: "index",
            statement: "CREATE INDEX ix ON salary (dept_no)",
            rationale: "the scan is sequential",
            evidence: [{ source: "artifact", correlationId: correlationIdsIn(turn.transcript).at(-1) }],
          }),
          "call_recommend",
        );
    const script = scriptedModel(
      ...Array.from({ length: 13 }, reads),
      ...Array.from({ length: 5 }, recommends),
      answersProse("done"),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // Narrowed at the ceiling with the instrument kept, then dropped once it had been used
    // three times: the fourth call is refused the way an unheld tool is.
    expect(namedIn(script, 12).sort()).toEqual(["compare_plans", "compose_report", "recommend_change"]);
    expect(namedIn(script, 16).sort()).toEqual(["compare_plans", "compose_report"]);
  });

  test("uses BEFORE the run was told to finish do not count against it", async () => {
    /*
      The first version of the rule above counted every use in the run, and a locked cell paid
      for it within the hour. `gemma4:26b` on database-assessment, measured immediately after:
      four `profile_table` calls, then five reads, then a refused read — ten calls, so its
      ceiling fired — and at that moment the count was already four. `profile_table` was taken
      away for work the run had done BEFORE anyone told it to stop, leaving one tool, and it
      stopped without reporting. That cell was 5/5.

      Those four profiles were not repetition. They were the assessment. What the narrowing is
      for is a run that keeps reaching for the same instrument AFTER being told to finish, so
      that is what is counted now: uses from the reminder onward, and every earlier one is the
      work.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "query-optimization");
    const recommends =
      () =>
      (turn: Turn): Response =>
        chatToolCallStream(
          "recommend_change",
          JSON.stringify({
            change: "index",
            statement: "CREATE INDEX ix ON salary (dept_no)",
            rationale: "the scan is sequential",
            evidence: [{ source: "artifact", correlationId: correlationIdsIn(turn.transcript).at(-1) }],
          }),
          "call_recommend",
        );
    const script = scriptedModel(
      // Reads first, because a recommendation has to cite one of them.
      ...Array.from({ length: 4 }, reads),
      ...Array.from({ length: 4 }, recommends),
      ...Array.from({ length: 4 }, reads),
      answersProse("done"),
      answersProse("done"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // Twelve calls, so the ceiling has fired — with four recommendations already behind it,
    // and the instrument its verdict is scored on still in its hands.
    expect(namedIn(script, 12).sort()).toEqual(["compare_plans", "compose_report", "recommend_change"]);
  });

  test("a narrowed run's other tools are REFUSED, not merely undeclared", async () => {
    /*
      Found by review on the first version of this: narrowing only what the model is
      TOLD about left the dispatch reading the full set, so a model that remembered a
      tool from an earlier turn had it executed anyway. A live run reached 25 calls after
      the ceiling fired at 12. Declaration and dispatch are one decision and are read
      from one place.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(...Array.from({ length: 13 }, reads), reads(), answersProse("done"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // The fourteenth call is a read the run no longer holds, and what comes back is the
    // same refusal a model inventing a tool name gets — not an execution.
    expect(script.turns[13]?.transcript ?? "").toContain("There is no tool called");
  });
});

// ─── telling a run to report at a moment it could obey ──────────────────────

/*
  The reminder is withheld from a run that called nothing, and two models are measured
  needing it anyway: they answer out of the inventory the run handed them instead of
  reaching for a tool, which from the drive looks the same as giving up.

  Granting it opened a second hole, and only a model that took the bypass could show it.
  One evaluated model on database-assessment heard the reminder as the FIRST entry in its
  ledger — before any read — obeyed, and was declined `UNVERIFIABLE_EVIDENCE` five times
  running; its first `profile_table` came after the last refusal. A run holding neither
  artifact nor snapshot cannot cite one, and the refusal that normally lists what to cite
  had nothing to list.

  So the bypass is split in two, per model: hearing it without tools, and waiting until
  there is something to cite. These pin both arms, because the value of the first is the
  run this second one would also stop.
*/
describe("a run is told to report only when it holds something to report from", () => {
  test("a turn that came back with nothing at all is asked once more", async () => {
    /*
      What `gemma4:26b` has been losing database-assessment to for fifteen measured runs, read
      properly for the first time.

      It was read as a model refusing to file: the run profiles its tables, counts things, and
      then produces a turn with no call and no report. Two fixes were aimed at that reading and
      both were measured and deleted — a second reminder took it from 4/5 to 2/5, a lower call
      ceiling to 3/5. Both were the wrong medicine, and its own profile said what was still
      missing: the text of the stopping turn.

      There is none. No `model-stopped-saying`, no `closing-statement` — both are written only
      when there is text — and ten seconds between the reminder and the end. The model did not
      argue and did not keep reading. It returned an EMPTY completion, and an empty turn ends
      the run as though the model had chosen to stop.

      So it is asked again. A run that has read something and not filed it has the whole job
      done but the last call, and one more turn is the cheapest thing this loop can spend.
      Once, per model, and off by default: a model that answers nothing twice is stopping.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b);
    // Two empty turns, which is the measured sequence: the FIRST is already survivable — it
    // draws the report reminder and the loop goes on. The second is where the run ended,
    // because the reminder is spent and an empty turn reads as a model that has stopped.
    const script = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT id FROM orders", rationale: "reading" }),
      answersProse(),
      answersProse(),
      reportOn("the orders table has rows"),
    );

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch, undefined, "gemma4:26b"),
      resources: b.resources,
    });

    expect(script.turns).toHaveLength(4);
    expect(result.stopReason).toBe("report-composed");
  });

  test("a refusal about the SHAPE of a call records which fields failed", async () => {
    /*
      The code alone could not be diagnosed. `INVALID_TOOL_INPUT` is the largest refusal
      family on record — around a hundred and fifty across every model measured — and
      One evaluated model produced eight against `recommend_change` in a single run, holding
      the tool throughout, while the ledger could only say the shape was wrong eight times.
      Which part of the object it kept getting wrong was unreadable, so no fix could be
      aimed at it.

      What goes in stays this server's own vocabulary: the validator's field paths and the
      types it expected. The arguments that failed them do not, which is why the refusal
      that lists a result's real column names carries no detail at all — those names are the
      engine's words.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b);
    const script = scriptedModel(
      callsTool("compose_report", { claims: "a sentence" }),
      answersProse("understood"),
      answersProse("understood"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    const view = await b.store.read(run.runId);
    const declined = view?.record.events.find((event) => event.kind === "call-declined");
    expect(declined?.kind === "call-declined" && declined.reasonCode).toBe("INVALID_TOOL_INPUT");
    expect(declined?.kind === "call-declined" && declined.detail).toContain("claims");
  });

  test("a field the schema offers a closed set for is refused with that set named", async () => {
    /*
      What the first version of this refusal could not distinguish, found by reading it.

      One evaluated model produced thirty-two `recommend_change` refusals in one run reading
      `change: invalid value` — and that sentence covers two different mistakes, an absent
      field and a value outside the set, because Zod reports one code for both. Neither the
      reader nor the MODEL could tell which it was, and the model is the one that had to act
      on it: it was told its `change` was wrong thirty-two times without ever being told that
      `index` and `rewrite` are the only two things it could be.

      Naming what would have worked is the move that carried this whole effort — it is what
      the worked example does, and what the citable-id list does. A closed set is the cheapest
      case of it: the values are in the schema, and the refusal already had them in hand.
    */
    const b = boot(freshDataDir());
    const run = await startRun(b, "agent", "query-optimization");
    const script = scriptedModel(
      callsTool("recommend_change", { statement: "CREATE INDEX ON salary (dept_no)" }),
      answersProse("understood"),
      answersProse("understood"),
    );

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    // The model reads the same sentence the ledger keeps, so one assertion covers both.
    expect(script.turns[1]?.transcript ?? "").toContain("index, rewrite");
    const view = await b.store.read(run.runId);
    const declined = view?.record.events.find((event) => event.kind === "call-declined");
    expect(declined?.kind === "call-declined" && declined.detail).toContain("one of index, rewrite");
  });
});

describe("a model that thinks instead of answering is told not to", () => {
  /*
    `qwen3.5:4b` locks five surfaces at the defaults and lost the sixth to its own reasoning:
    asked for one statement it returns 13 188 characters of thinking against 1 165 of content,
    and the five plan runs spent 90, 170 and 179 seconds against a 90-second turn, each leaving
    an empty ledger.

    `reasoning_effort` is what the OpenAI-compatible endpoint the agent drives actually reads -
    `think: false` is Ollama's own API and is ignored here, as is `enable_thinking`. The
    in-prompt `/no_think` marker looked right on ONE run and did not reproduce: 38 s in the
    system prompt, 51 s in the user message, and 1/5 in a real sweep.

    A REQUEST FIELD, not a word in the prompt: nothing is spliced into what Studio says to a
    model, and no cell's measured wording moves.
  */
  test.each(["ollama", "openai"] as const)(
    "the field reaches a model configured as %s, because the adapter is the same one",
    async (provider) => {
      /*
        BOTH providers, and ollama first, because that is where this broke. The options were
        keyed by the provider's own name; the scripted model is `openai` by default, so a
        single-provider test passed while every real ollama run sent nothing and timed out.
      */
      const b = boot(freshDataDir());
      const run = await startRun(b, "planning");
      const script = scriptedModel(answersProse("```sqlite\nSELECT 1\n```"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch, "https://api.openai.com/v1", "qwen3.5:4b", provider),
        resources: b.resources,
      });

      expect(script.turns[0]?.body?.reasoning_effort).toBe(PLAN_NO_REASONING_EFFORT);
    },
  );

  test("a model nobody measured thinking at is left thinking", async () => {
    // Off by default: a drive-wide change here is how this repository has twice handed back
    // cells it had already won.
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("```sqlite\nSELECT 1\n```"));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch, "https://api.openai.com/v1", "gemma4:26b"),
      resources: b.resources,
    });

    expect(script.turns[0]?.body?.reasoning_effort).toBeUndefined();
  });

  test.each(["native", "prompted"] as const)(
    "an AGENT run of the same model is left alone, on the %s protocol",
    async (protocol) => {
      /*
        BOTH protocols, and the prompted one is why this runs twice.

        Gating on `tools === undefined` is true for a planning run AND for every turn of an
        agent run that asks for its tools in prose - the path four of the twenty-five measured
        models take, because none of them can emit `tool_calls`. So a setting documented as
        PLAN ONLY would reach agent turns of exactly the models most likely to be running
        locally, and a single-protocol test would pass anyway because `startRun` defaults to
        `native`. It is gated on the run's MODE, which is what it was always about.
      */
      const b = boot(freshDataDir());
      const run = await startRun(b, "agent", undefined, undefined, protocol);
      const script = scriptedModel(answersProse("nothing to add"));

      await runInvestigation(run.runId, {
        service: b.service,
        model: await modelOver(script.fetch, "https://api.openai.com/v1", "qwen3.5:4b"),
        resources: b.resources,
      });

      expect(script.turns[0]?.body?.reasoning_effort).toBeUndefined();
    },
  );
});
