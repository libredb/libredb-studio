import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_RUN_DEADLINE_MS } from "@/lib/agent/execution-policy";
import { type AgentToolResources, runInvestigation } from "@/lib/agent/investigation";
import type { AgentModel } from "@/lib/agent/model-adapter";
import { resolveAgentProviderAdapter } from "@/lib/agent/provider-registry";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService, AgentRunServiceError } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunActor, AgentRunEvent, AgentRunRecord } from "@/lib/agent/types";
import { UNTRUSTED_CONTENT_BEGIN } from "@/lib/agent/untrusted-content";
import { QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { LLMAuthError } from "@/lib/llm/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import {
  chatNeverAnswers,
  chatTextStream,
  chatToolCallStream,
  endpointError,
  type FetchDouble,
} from "./fixtures/agent-transport";

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
      deadline: new AgentRunDeadline(AGENT_RUN_DEADLINE_MS, deadlineClock),
      repairs: new AgentRepairLedger(),
      acquireProvider,
    },
    queryReadOnly,
    acquireProvider,
  };
}

// ─── the scripted model ─────────────────────────────────────────────────────

interface Turn {
  readonly body: Record<string, unknown>;
  readonly transcript: string;
  /**
   * The signal the SDK handed the transport. Present so a fixture can end a
   * response the way a real `fetch` does; verified against the installed package,
   * which forwards its `abortSignal` here rather than only watching it itself.
   */
  readonly signal: AbortSignal | null | undefined;
}

/**
 * A call that never answers, and ends the only way a real one can: when the transport
 * is aborted.
 *
 * A promise that simply never settles would be an unfaithful double — a real `fetch`
 * rejects when its signal fires, and a fixture that ignores the signal tests a
 * transport nobody ships. It also hangs the test rather than failing it, which reads
 * as "the ceiling does not work" whatever the code does.
 */
const unansweredCall = (turn: Turn): Promise<Response> =>
  new Promise((_resolve, reject) => {
    turn.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
  });

/**
 * A model whose every turn is a function of what it was actually sent.
 *
 * A turn may answer asynchronously: the cancellation test needs one that records a
 * stop request while the model is "thinking", which is the only way to reach the
 * loop's checkpoint from outside it.
 */
function scriptedModel(...turns: readonly ((turn: Turn) => Response | Promise<Response>)[]): {
  fetch: FetchDouble;
  turns: Turn[];
} {
  const seen: Turn[] = [];
  const fetchImpl: FetchDouble = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const turn: Turn = { body, transcript: JSON.stringify(body.messages ?? []), signal: init?.signal };
    seen.push(turn);
    const next = turns[seen.length - 1];
    // Running out of scripted turns IS the simulated process death: the driving
    // process stops answering, exactly as it would if it had been killed.
    if (!next) throw new TypeError(`the driving process died before turn ${seen.length}`);
    return next(turn);
  };
  return { fetch: fetchImpl, turns: seen };
}

async function modelOver(fetchImpl: FetchDouble): Promise<AgentModel> {
  const config = {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
  } as const;
  return {
    provider: "openai",
    modelId: config.model,
    model: await resolveAgentProviderAdapter("openai").createModel(config, fetchImpl),
  };
}

const callsTool =
  (name: string, input: unknown, callId = "call_1") =>
  (): Response =>
    chatToolCallStream(name, JSON.stringify(input), callId);

const answersProse =
  (...deltas: string[]) =>
  (): Response =>
    chatTextStream(...deltas);

/**
 * The correlation id of a read this run performed, taken from the transcript the
 * way a model would have to take it: `executeAuditedOperation` mints a plain UUID,
 * and it reaches the transcript either in a fenced result's header or in the
 * prior-progress summary a resumed run is given.
 */
function correlationIdIn(transcript: string): string {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(transcript);
  if (!match) throw new Error(`no artifact reference in the transcript: ${transcript.slice(0, 400)}`);
  return match[0];
}

const reportOn =
  (claim = "The orders report scans the whole table.") =>
  (turn: Turn): Response =>
    chatToolCallStream(
      "compose_report",
      JSON.stringify({
        claims: [{ claim, evidence: [{ source: "artifact", correlationId: correlationIdIn(turn.transcript) }] }],
      }),
      "call_report",
    );

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

function invocationsOf(events: readonly AgentRunEvent[]): string[] {
  return events.filter((event) => event.kind === "tool-invoked").map((event) => event.stepId);
}

async function startRun(boot: Boot, mode: "agent" | "planning" = "agent"): Promise<AgentRunRecord> {
  return boot.service.start({ mode, actor: ACTOR, connectionId: "conn_1", objective: OBJECTIVE });
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
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

// ─── planning mode ──────────────────────────────────────────────────────────

describe("planning mode performs zero database operations", () => {
  test("no tool is offered, no provider is acquired, and the prose is returned", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("First ", "look at the index."));

    const result = await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(script.turns[0]?.body.tools).toBeUndefined();
    expect(b.acquireProvider).not.toHaveBeenCalled();
    expect(b.queryReadOnly).not.toHaveBeenCalled();
    expect(result.status).toBe("succeeded");
    expect(result.stopReason).toBe("model-stopped");
    expect(result.text).toBe("First look at the index.");
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
    expect(b.acquireProvider).not.toHaveBeenCalled();
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

    expect(b.acquireProvider).not.toHaveBeenCalled();
    expect(invocationsOf(await eventsOf(b.store, run.runId))).toEqual([]);
    expect(script.turns[1]?.transcript).toContain("run_read_query");
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

  /*
    A model call that never answers used to cost the whole run.

    Measured, not assumed: one planning run on 2026-08-12 ended at 300.0s — exactly
    `AGENT_RUN_DEADLINE_MS` — with a two-event ledger. The deadline did its job
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
    expect(Date.now() - started).toBeLessThan(AGENT_RUN_DEADLINE_MS);

    const finished = (await eventsOf(b.store, run.runId)).find((event) => event.kind === "run-finished");
    expect(finished).toMatchObject({ status: "failed", stopReason: "model-timeout" });
  });

  test("a run that runs out of time is still reported as out of time, not as a slow call", async () => {
    // The turn ceiling must not relabel the run deadline: when less time remains than
    // a turn is allowed, the shorter bound is the run's own, and the reason follows it.
    const b = boot(freshDataDir(), { spentMs: AGENT_RUN_DEADLINE_MS - 100 });
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
    const b = boot(freshDataDir(), { spentMs: AGENT_RUN_DEADLINE_MS + 1_000 });
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
    const b = boot(freshDataDir(), { spentMs: AGENT_RUN_DEADLINE_MS - 40 });
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

  test("a planning run captures nothing and reaches no database", async () => {
    const b = boot(freshDataDir());
    const run = await startRun(b, "planning");
    const script = scriptedModel(answersProse("I would start with the index."));

    await runInvestigation(run.runId, {
      service: b.service,
      model: await modelOver(script.fetch),
      resources: b.resources,
    });

    expect(b.acquireProvider).not.toHaveBeenCalled();
    expect(kindsOf(await eventsOf(b.store, run.runId))).not.toContain("context-captured");
    // Not merely skipped for cost: a planning run is never even TOLD that a schema
    // inventory was unavailable, because it was never going to read one.
    expect(script.turns[0]?.transcript).not.toContain("inspect_schema");
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
