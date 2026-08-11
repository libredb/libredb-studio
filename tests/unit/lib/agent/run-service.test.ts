import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunService, AgentRunServiceError } from "@/lib/agent/run-service";
import type { AgentRunStepSettlement } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunActor } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import type { QueryResult } from "@/lib/types";

/**
 * As in `run-store.test.ts`, the backend here is a REAL `@workflow/world-local`
 * over a temporary data directory. Two properties this suite asserts are only
 * meaningful against a real one: that a tool invocation is durably readable by a
 * SECOND store instance before the effect it announces has happened, and that a
 * cancellation recorded by one caller is honoured by the run loop's own
 * checkpoint rather than by a driver cancel propagating.
 */

const ACTOR: AgentRunActor = { sessionId: "sess_1", role: "admin" };
const OTHER_ACTOR: AgentRunActor = { sessionId: "sess_2", role: "user" };

const START_INPUT = {
  mode: "agent",
  actor: ACTOR,
  connectionId: "conn_1",
  objective: "Why is the orders report slow?",
} as const;

const dataDirs: string[] = [];

interface Harness {
  readonly service: AgentRunService;
  readonly store: AgentRunStore;
  readonly dataDir: string;
  readonly tracker: ExecutionBudgetTracker;
  readonly artifacts: ExecutionArtifactStore<QueryResult>;
  /** A second store over the same files — what a restarted process, or a reader, sees. */
  readonly reader: () => AgentRunStore;
}

function harness(clock?: () => number): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-service-"));
  dataDirs.push(dataDir);
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }), clock });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 20 });
  return {
    service: new AgentRunService({ store, resources: { tracker, artifacts }, clock }),
    store,
    dataDir,
    tracker,
    artifacts,
    reader: () => new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }), clock }),
  };
}

function fakeClock(startAt = 1_700_000_000_000): { read: () => number; set: (value: number) => void } {
  let current = startAt;
  return {
    read: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function artifactReference(runId: string, correlationId = "corr_1") {
  return {
    correlationId,
    runId,
    operationId: "sql.query.read",
    summary: { rowCount: 2, columnNames: ["id"], elapsedMs: 7 },
  };
}

const COMPLETED = (runId: string): AgentRunStepSettlement => ({
  kind: "completed",
  artifact: artifactReference(runId),
});

/** Gives the run something to lose: one accounted statement and one stored artifact. */
function spendRunResources(h: Harness, runId: string): void {
  h.tracker.beginExecution(runId);
  h.tracker.endExecution(runId, { statements: 1, elapsedMs: 25 });
  h.artifacts.put(
    {
      correlationId: "corr_1",
      runId,
      operationId: "sql.query.read",
      createdAtMs: 1_000,
      value: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 25 },
    },
    1_000,
  );
}

async function captureServiceError(fn: () => Promise<unknown>): Promise<AgentRunServiceError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRunServiceError);
    return error as AgentRunServiceError;
  }
  throw new Error("expected the service to refuse");
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the lifecycle ──────────────────────────────────────────────────────────

describe("AgentRunService — starting and reporting a run", () => {
  test("a started run is queued, and its status report says so", async () => {
    const h = harness();
    const record = await h.service.start(START_INPUT);

    const report = await h.service.status(record.runId);

    expect(report).toMatchObject({
      record: { runId: record.runId, status: "queued", mode: "agent", actor: ACTOR },
      cancellationRequested: false,
    });
  });

  test("a run the loop has picked up reads as running", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);

    await h.service.markRunning(runId);

    const report = await h.service.status(runId);
    expect(report?.record.status).toBe("running");
    expect(report?.record.events.map((entry) => entry.kind)).toEqual(["run-started"]);
  });

  test("the run-started event records the run's persisted mode, not a caller's claim", async () => {
    const h = harness();
    const { runId } = await h.service.start({ ...START_INPUT, mode: "planning" });

    const record = await h.service.markRunning(runId);

    expect(record.events[0]).toMatchObject({ kind: "run-started", mode: "planning" });
  });

  test("reports nothing for a run that does not exist", async () => {
    const h = harness();
    expect(await h.service.status("arun_00000000000000000000000000000000")).toBeNull();
  });

  test("refuses to start a run twice on one id, and refuses to re-start a running one", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    expect((await captureServiceError(() => h.service.markRunning(runId))).reasonCode).toBe("RUN_NOT_STARTABLE");
  });

  test("refuses to mark an unknown run as running", async () => {
    const h = harness();
    expect((await captureServiceError(() => h.service.markRunning("arun_ff"))).reasonCode).toBe("RUN_NOT_FOUND");
  });
});

// ─── narrated entries ───────────────────────────────────────────────────────

/**
 * `recordEvent` is what the run loop uses to say what it DECIDED, as opposed to
 * what happened to a tool. The investigation suite drives it end to end; these
 * pin the method's own contract, which is where a later reader would look for it.
 */
describe("AgentRunService — recording what a run narrated", () => {
  test("a narrative entry lands in the ledger, stamped from the injected clock", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    clock.set(1_700_000_123_000);
    await h.service.recordEvent(runId, { kind: "context-captured", fingerprint: "fp_1", tableCount: 3 });

    const view = await h.store.read(runId);
    expect(view?.record.events.at(-1)).toEqual({
      kind: "context-captured",
      fingerprint: "fp_1",
      tableCount: 3,
      // The caller supplies no timestamp, so a run's history cannot be dated from
      // a clock other than the one every other entry uses.
      atMs: 1_700_000_123_000,
    });
  });

  test("refuses a run the loop has not picked up yet, and writes nothing", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);

    const error = await captureServiceError(() =>
      h.service.recordEvent(runId, { kind: "report-composed", claims: [] }),
    );

    expect(error.reasonCode).toBe("RUN_NOT_RUNNING");
    expect((await h.store.read(runId))?.record.events).toEqual([]);
  });

  test("refuses a run that has already ended", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    await h.service.finish(runId, "succeeded");

    const error = await captureServiceError(() =>
      h.service.recordEvent(runId, { kind: "statement-drafted", stepId: "s1", sql: "SELECT 1", rationale: "why" }),
    );

    expect(error.reasonCode).toBe("RUN_NOT_RUNNING");
  });

  test("refuses a run that does not exist", async () => {
    const h = harness();
    const error = await captureServiceError(() =>
      h.service.recordEvent("arun_ff", { kind: "context-captured", fingerprint: "fp_1", tableCount: 0 }),
    );

    expect(error.reasonCode).toBe("RUN_NOT_FOUND");
  });
});

describe("AgentRunService — finishing a run", () => {
  test("a finished run is terminal and releases its budget and its artifacts together", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    spendRunResources(h, runId);

    expect(h.tracker.usage(runId).executedStatements).toBe(1);
    expect(h.artifacts.size).toBe(1);

    const record = await h.service.finish(runId, "succeeded");

    expect(record.status).toBe("succeeded");
    expect(h.tracker.usage(runId)).toEqual({ activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 });
    expect(h.artifacts.get("corr_1", 1_000)).toBeUndefined();
    expect(h.artifacts.size).toBe(0);
  });

  test("refuses to finish a run that has already finished", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.finish(runId, "failed");

    const error = await captureServiceError(() => h.service.finish(runId, "succeeded"));
    expect(error.reasonCode).toBe("RUN_ALREADY_TERMINAL");
    expect((await h.service.status(runId))?.record.status).toBe("failed");
  });

  test("refuses to finish a run that does not exist", async () => {
    const h = harness();
    expect((await captureServiceError(() => h.service.finish("arun_ff", "succeeded"))).reasonCode).toBe(
      "RUN_NOT_FOUND",
    );
  });

  test("refuses to end a run while one of its executions is live, and persists nothing", async () => {
    // The accounting refuses to release a run with a statement in flight, and it
    // refuses AFTER the ledger would have been written. So the check has to come
    // first: a run recorded as finished whose budget and artifacts were never
    // released is unrecoverable — `finish` then refuses it as already terminal,
    // and its stream never closes.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    spendRunResources(h, runId);
    h.tracker.beginExecution(runId);

    const error = await captureServiceError(() => h.service.finish(runId, "succeeded"));

    expect(error.reasonCode).toBe("RUN_HAS_LIVE_EXECUTION");
    expect((await h.service.status(runId))?.record.status).toBe("running");
    expect(h.artifacts.size).toBe(1);

    // And the run is still finishable once the statement lands, which is what
    // "persists nothing" buys.
    h.tracker.endExecution(runId, { statements: 1, elapsedMs: 5 });
    expect((await h.service.finish(runId, "succeeded")).status).toBe("succeeded");
    expect(h.artifacts.size).toBe(0);
  });

  test("ending a run closes its timeline, so a live reader completes instead of hanging", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    const reader = (await h.service.stream(runId)).getReader();

    await h.service.finish(runId, "succeeded");

    // Drains to `done`. If the ending did not close the stream this never
    // terminates, which is exactly the hang an SSE reader of a finished run would
    // see — the failure mode the ordering in `finalize` exists to avoid.
    const kinds: string[] = [];
    let next = await reader.read();
    while (!next.done) {
      kinds.push(next.value.kind);
      next = await reader.read();
    }
    expect(kinds).toEqual(["run-opened", "event", "event"]);
  });

  test("closes the timeline even when releasing the run's resources fails", async () => {
    // The release is the step that can refuse. Whatever it does, a run whose
    // ending is already durable must not leave readers waiting forever.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    const reader = (await h.service.stream(runId)).getReader();
    const boom = new Error("accounting is corrupt");
    spyOn(h.tracker, "endRun").mockImplementation(() => {
      throw boom;
    });

    await expect(h.service.finish(runId, "succeeded")).rejects.toBe(boom);

    let next = await reader.read();
    while (!next.done) next = await reader.read();
    expect(next.done).toBe(true);
  });

  test("finishing a run with a stop pending records what happened, not what was asked for", async () => {
    // Deliberate: the loop got to the end before it reached a checkpoint, so the
    // work did succeed. The request stays visible in the report rather than being
    // rewritten into the outcome.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    await h.service.cancel(runId, OTHER_ACTOR);

    const record = await h.service.finish(runId, "succeeded");

    expect(record.status).toBe("succeeded");
    expect((await h.service.status(runId))?.cancellationRequested).toBe(true);
  });
});

// ─── cancellation ───────────────────────────────────────────────────────────

describe("AgentRunService — cancellation", () => {
  test("cancelling a run that no loop has picked up ends it immediately", async () => {
    // Nothing is executing, so there is no checkpoint to wait for: leaving the
    // run queued with a pending request would mean a cancel that never lands.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);

    const report = await h.service.cancel(runId, OTHER_ACTOR);

    expect(report.record.status).toBe("cancelled");
    expect(report.record.events.map((entry) => entry.kind)).toEqual(["run-finished"]);
  });

  test("cancelling a running run records the request and leaves the run for its own loop to end", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    const report = await h.service.cancel(runId, OTHER_ACTOR);

    expect(report.record.status).toBe("running");
    expect(report.cancellationRequested).toBe(true);
  });

  test("the run loop honours the request at its next step, and releases budget and artifacts together", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    spendRunResources(h, runId);
    await h.service.cancel(runId, OTHER_ACTOR);

    let executed = false;
    const result = await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => {
      executed = true;
      return COMPLETED(runId);
    });

    expect(result.kind).toBe("cancelled");
    expect(executed).toBe(false);
    const report = await h.service.status(runId);
    expect(report?.record.status).toBe("cancelled");
    expect(report?.record.events.at(-1)).toMatchObject({ kind: "run-finished", status: "cancelled" });
    expect(h.tracker.usage(runId)).toEqual({ activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 });
    expect(h.artifacts.size).toBe(0);
  });

  test("a cancellation requested in another process is honoured by this one", async () => {
    // The request is durable state, not an in-memory flag, which is what makes
    // it work across the loopback transport and across a restart.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    await h.reader().requestCancellation(runId, OTHER_ACTOR);

    const result = await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () =>
      COMPLETED(runId),
    );
    expect(result.kind).toBe("cancelled");
  });

  test("cancelling a terminal run changes nothing and writes nothing at all", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.finish(runId, "succeeded");
    // Asserted on the store's writes, not on a later read: the backend stops a
    // snapshot read at the stream's end marker, so an append after `close` lands
    // on disk and is invisible to `read()`. A read-side assertion would therefore
    // pass even if a second ending HAD been appended.
    const appendEvent = spyOn(h.store, "appendEvent");
    const requestCancellation = spyOn(h.store, "requestCancellation");

    const report = await h.service.cancel(runId, OTHER_ACTOR);

    expect(appendEvent).not.toHaveBeenCalled();
    expect(requestCancellation).not.toHaveBeenCalled();
    expect(report.record.status).toBe("succeeded");
    expect(report.record.events.filter((entry) => entry.kind === "run-finished")).toHaveLength(1);
  });

  test("refuses to cancel a run that does not exist", async () => {
    const h = harness();
    expect((await captureServiceError(() => h.service.cancel("arun_ff", ACTOR))).reasonCode).toBe("RUN_NOT_FOUND");
  });
});

// ─── the write-ahead invariant ──────────────────────────────────────────────

describe("AgentRunService — a tool execution is in the ledger before its effect", () => {
  test("a reader sees the invocation before the effect happens, and the outcome only after", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    const reader = h.reader();

    let seenDuringEffect: readonly string[] = [];
    const result = await h.service.runStep(
      runId,
      { stepId: "s1", tool: "run_read_query", operationId: "sql.query.read" },
      async () => {
        // Read the ledger from a SECOND store, over its own world instance: this
        // is the assertion on the store rather than on the service's intentions.
        const view = await reader.read(runId);
        seenDuringEffect = (view?.record.events ?? []).map((entry) => entry.kind);
        return COMPLETED(runId);
      },
    );

    expect(seenDuringEffect).toEqual(["run-started", "tool-invoked"]);
    expect(result).toMatchObject({ kind: "performed", settlement: { kind: "completed" } });
    const after = await reader.read(runId);
    expect(after?.record.events.map((entry) => entry.kind)).toEqual(["run-started", "tool-invoked", "tool-completed"]);
    expect(after?.settledSteps.get("s1")?.kind).toBe("tool-completed");
  });

  test("records the operation a tool drove, so an artifact reference joins the audit trail", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    await h.service.runStep(
      runId,
      { stepId: "s1", tool: "inspect_plan", operationId: "sql.explain.estimate" },
      async () => COMPLETED(runId),
    );

    const view = await h.store.read(runId);
    expect(view?.record.events[1]).toMatchObject({
      kind: "tool-invoked",
      tool: "inspect_plan",
      operationId: "sql.explain.estimate",
    });
  });

  test("a refusal settles the step as a refusal, with no engine text attached to it", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    const result = await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => ({
      kind: "refused",
      refusal: { class: "policy-denied", reasonCode: "ROLE_FORBIDDEN" },
    }));

    expect(result).toMatchObject({ kind: "performed", settlement: { kind: "refused" } });
    const view = await h.store.read(runId);
    expect(view?.record.events.at(-1)).toEqual({
      kind: "tool-refused",
      atMs: expect.any(Number),
      stepId: "s1",
      refusal: { class: "policy-denied", reasonCode: "ROLE_FORBIDDEN" },
    });
  });

  test("a call the layer never attempted leaves no outcome event to replay", async () => {
    // `not-attempted` is the run loop's own outcome (a deadline, a repair-ledger
    // refusal, a toolless mode): nothing was asked of the database, so there is
    // no policy answer and no database error to record. T2's event union has no
    // variant for it and this task does not widen that union.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    const result = await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => ({
      kind: "not-attempted",
    }));

    expect(result).toMatchObject({ kind: "performed", settlement: { kind: "not-attempted" } });
    const view = await h.store.read(runId);
    expect(view?.record.events.map((entry) => entry.kind)).toEqual(["run-started", "tool-invoked"]);
    expect(view?.unsettledStepIds).toEqual(["s1"]);
  });

  test("an executor that throws leaves the invocation recorded and the step unsettled", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);

    const boom = new Error("the pool went away");
    await expect(
      h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const view = await h.store.read(runId);
    expect(view?.unsettledStepIds).toEqual(["s1"]);
    expect(view?.record.status).toBe("running");
  });

  test("refuses a step on a run that is already terminal", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.finish(runId, "succeeded");

    let executed = false;
    const error = await captureServiceError(() =>
      h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => {
        executed = true;
        return COMPLETED(runId);
      }),
    );
    expect(error.reasonCode).toBe("RUN_ALREADY_TERMINAL");
    expect(executed).toBe(false);
  });

  test("refuses a step on a run no loop has marked running", async () => {
    // Without this, "a queued run has nothing in flight" would be an assumption
    // rather than a fact — and `cancel` ends a queued run on the spot, precisely
    // because it believes nothing is executing.
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);

    let executed = false;
    const error = await captureServiceError(() =>
      h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => {
        executed = true;
        return COMPLETED(runId);
      }),
    );

    expect(error.reasonCode).toBe("RUN_NOT_RUNNING");
    expect(executed).toBe(false);
    expect((await h.store.read(runId))?.record.events).toEqual([]);
  });

  test("refuses a step on a run that does not exist", async () => {
    const h = harness();
    expect(
      (
        await captureServiceError(() =>
          h.service.runStep("arun_ff", { stepId: "s1", tool: "run_read_query" }, async () => COMPLETED("arun_ff")),
        )
      ).reasonCode,
    ).toBe("RUN_NOT_FOUND");
  });
});

// ─── replay ─────────────────────────────────────────────────────────────────

describe("AgentRunService — replaying a step instead of re-performing it", () => {
  test("a step already settled in the ledger is replayed, not executed again", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => COMPLETED(runId));

    let executed = false;
    const result = await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => {
      executed = true;
      return COMPLETED(runId);
    });

    expect(executed).toBe(false);
    expect(result).toMatchObject({ kind: "replayed", event: { kind: "tool-completed", stepId: "s1" } });
    const view = await h.store.read(runId);
    expect(view?.record.events.filter((entry) => entry.kind === "tool-invoked")).toHaveLength(1);
    expect(view?.record.events.filter((entry) => entry.kind === "tool-completed")).toHaveLength(1);
  });

  test("a step whose invocation was recorded but never settled is not executed again either", async () => {
    // This is the state a process death between the ledger write and the effect
    // leaves behind. Whether the statement ran cannot be known from here, so the
    // only honest answers are "do not repeat it" and "say the result is unknown".
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    await h.store.appendEvent(runId, {
      kind: "tool-invoked",
      atMs: 5,
      stepId: "s1",
      tool: "run_read_query",
    });

    let executed = false;
    const result = await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => {
      executed = true;
      return COMPLETED(runId);
    });

    expect(executed).toBe(false);
    expect(result).toEqual({ kind: "indeterminate", stepId: "s1" });
    const view = await h.store.read(runId);
    expect(view?.record.events.filter((entry) => entry.kind === "tool-invoked")).toHaveLength(1);
  });
});

// ─── resume ─────────────────────────────────────────────────────────────────

describe("AgentRunService — resuming a run", () => {
  test("reports what the ledger already settled, so a resumed run re-derives instead of re-running", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    await h.service.runStep(runId, { stepId: "settled", tool: "run_read_query" }, async () => COMPLETED(runId));
    await h.store.appendEvent(runId, { kind: "tool-invoked", atMs: 9, stepId: "hanging", tool: "inspect_schema" });

    // A restarted process reads the run through its own store instance.
    const restarted = new AgentRunService({
      store: h.reader(),
      resources: { tracker: h.tracker, artifacts: h.artifacts },
    });
    const report = await restarted.resume(runId);

    expect(report.record.status).toBe("running");
    expect(report.settledStepIds).toEqual(["settled"]);
    expect(report.indeterminateStepIds).toEqual(["hanging"]);
    expect(report.cancellationRequested).toBe(false);
  });

  test("refuses to resume a terminal run", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.finish(runId, "succeeded");

    expect((await captureServiceError(() => h.service.resume(runId))).reasonCode).toBe("RUN_NOT_RESUMABLE");
  });

  test("refuses to resume a run that does not exist", async () => {
    const h = harness();
    expect((await captureServiceError(() => h.service.resume("arun_ff"))).reasonCode).toBe("RUN_NOT_FOUND");
  });

  test("a resumed run whose cancellation was requested reports it", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);
    await h.service.markRunning(runId);
    await h.service.cancel(runId, OTHER_ACTOR);

    const report = await h.service.resume(runId);
    expect(report.cancellationRequested).toBe(true);
  });
});

// ─── the stream ─────────────────────────────────────────────────────────────

describe("AgentRunService — streaming a run's timeline", () => {
  test("streams the run's entries as they are appended", async () => {
    const h = harness();
    const { runId } = await h.service.start(START_INPUT);

    const stream = await h.service.stream(runId);
    const reader = stream.getReader();
    try {
      expect((await reader.read()).value).toMatchObject({ kind: "run-opened", mode: "agent" });
      await h.service.markRunning(runId);
      expect((await reader.read()).value).toMatchObject({ kind: "event", event: { kind: "run-started" } });
    } finally {
      await reader.cancel();
    }
  });

  test("refuses to stream a run that does not exist", async () => {
    const h = harness();
    expect((await captureServiceError(() => h.service.stream("arun_ff"))).reasonCode).toBe("RUN_NOT_FOUND");
  });
});

// ─── clock discipline ───────────────────────────────────────────────────────

describe("AgentRunService — timestamps", () => {
  test("every event it appends is stamped from the injected clock", async () => {
    const clock = fakeClock();
    const h = harness(clock.read);
    const { runId } = await h.service.start(START_INPUT);

    clock.set(1_700_000_050_000);
    await h.service.markRunning(runId);
    clock.set(1_700_000_060_000);
    await h.service.runStep(runId, { stepId: "s1", tool: "run_read_query" }, async () => COMPLETED(runId));
    clock.set(1_700_000_070_000);
    await h.service.finish(runId, "succeeded");

    const view = await h.store.read(runId);
    expect(view?.record.events.map((entry) => entry.atMs)).toEqual([
      1_700_000_050_000, 1_700_000_060_000, 1_700_000_060_000, 1_700_000_070_000,
    ]);
    expect(view?.record.createdAtMs).toBe(1_700_000_000_000);
  });
});
