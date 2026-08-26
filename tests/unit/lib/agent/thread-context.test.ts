import { describe, expect, test } from "bun:test";
import {
  AGENT_THREAD_CONTEXT_MAX_CHARS,
  AGENT_THREAD_MAX_STEPS,
  AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS,
} from "@/lib/agent/execution-policy";
import { deriveThreadContext } from "@/lib/agent/thread-context";
import type {
  AgentEvidenceReference,
  AgentRunEvent,
  AgentRunRecord,
  AgentThreadContext,
  AgentThreadStep,
} from "@/lib/agent/types";

/**
 * `deriveThreadContext` is pure: it assembles the conversation a follow-up run is
 * handed from the predecessor's own record. These tests feed it records shaped the
 * way the ledger folds them, with no store and no model behind them.
 *
 * The two halves it builds have different sources, and most of what is asserted
 * here is about the boundary between them: the SPINE comes off the predecessor's
 * header and names every step, while the EVIDENCE comes off the predecessor's own
 * events and names only its own report.
 */

const ACTOR = { sessionId: "sess_1", role: "admin" } as const;

const EVIDENCE: AgentEvidenceReference = { source: "artifact", correlationId: "corr_1" };

/** Spelled once here and asserted against the module's own output, not re-derived. */
const REPORT_CUT_NOTICE_TEXT = "[The rest of this step's report is not shown here.]";

function threadOf(steps: readonly AgentThreadStep[], threadId = "arun_1"): AgentThreadContext {
  return { threadId, steps, text: "" };
}

function record(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: "arun_prev",
    mode: "agent",
    workflowType: "data-analysis",
    workflowSource: "chosen",
    workflowReading: "unrecorded",
    autoExecute: false,
    status: "succeeded",
    actor: ACTOR,
    connectionId: "conn_1",
    objective: "chart those",
    thread: threadOf([], "arun_prev"),
    createdAtMs: 1,
    updatedAtMs: 2,
    events: [],
    ...overrides,
  };
}

function reportEvent(...claims: readonly string[]): AgentRunEvent {
  return {
    kind: "report-composed",
    atMs: 2,
    claims: claims.map((claim) => ({ claim, evidence: [EVIDENCE] })),
  } as AgentRunEvent;
}

function answerEvent(sql: string): AgentRunEvent {
  return { kind: "answer-composed", atMs: 1, sql } as AgentRunEvent;
}

describe("deriveThreadContext", () => {
  test("the predecessor becomes the newest step, after the steps it already carried", () => {
    const previous = record({
      runId: "arun_2",
      objective: "chart those",
      thread: threadOf([{ runId: "arun_1", objective: "count by department" }]),
    });

    const derived = deriveThreadContext(previous);

    expect(derived.threadId).toBe("arun_1");
    expect(derived.steps).toEqual([
      { runId: "arun_1", objective: "count by department" },
      { runId: "arun_2", objective: "chart those" },
    ]);
  });

  test("a run that starts a conversation contributes the only step, under its own id", () => {
    const derived = deriveThreadContext(record({ runId: "arun_1", objective: "count by department" }));

    expect(derived.threadId).toBe("arun_prev");
    expect(derived.steps).toEqual([{ runId: "arun_1", objective: "count by department" }]);
  });

  test("the spine names every step oldest first, and the evidence is the newest step's report", () => {
    const previous = record({
      runId: "arun_2",
      objective: "chart those",
      thread: threadOf([{ runId: "arun_1", objective: "count by department" }]),
      events: [answerEvent("SELECT department, count(*) FROM employees GROUP BY 1"), reportEvent("Nine departments")],
    });

    const { text } = deriveThreadContext(previous);

    expect(text).toContain("Step 1: count by department");
    expect(text).toContain("Step 2: chart those");
    expect(text).toContain("Answer statement: SELECT department, count(*) FROM employees GROUP BY 1");
    expect(text).toContain("Claim 1: Nine departments");
    expect(text.indexOf("Step 1:")).toBeLessThan(text.indexOf("Claim 1:"));
  });

  test("a closing statement is carried as part of the report", () => {
    const previous = record({
      events: [{ kind: "closing-statement", atMs: 3, text: "Nothing further was established." } as AgentRunEvent],
    });

    expect(deriveThreadContext(previous).text).toContain("Closing: Nothing further was established.");
  });

  test("a carried objective is capped, and says it was cut", () => {
    const derived = deriveThreadContext(record({ objective: "x".repeat(500) }));

    const carried = derived.steps.at(-1)?.objective ?? "";
    expect(carried.length).toBeLessThanOrEqual(AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS);
    expect(carried.endsWith("...")).toBe(true);
  });

  test("an objective inside the cap is carried whole", () => {
    const derived = deriveThreadContext(record({ objective: "count by department" }));

    expect(derived.steps.at(-1)?.objective).toBe("count by department");
  });

  test("past the step cap the OLDEST steps are dropped, and the text says how many", () => {
    const carried = Array.from({ length: AGENT_THREAD_MAX_STEPS }, (_, index) => ({
      runId: `arun_${index}`,
      objective: `step ${index}`,
    }));
    const derived = deriveThreadContext(record({ runId: "arun_new", thread: threadOf(carried, "arun_0") }));

    expect(derived.steps).toHaveLength(AGENT_THREAD_MAX_STEPS);
    expect(derived.steps[0]?.runId).toBe("arun_1");
    expect(derived.steps.at(-1)?.runId).toBe("arun_new");
    expect(derived.text).toContain("1 earlier step is no longer carried");
  });

  test("more than one dropped step is counted in the plural", () => {
    const carried = Array.from({ length: AGENT_THREAD_MAX_STEPS + 4 }, (_, index) => ({
      runId: `arun_${index}`,
      objective: `step ${index}`,
    }));
    const derived = deriveThreadContext(record({ runId: "arun_new", thread: threadOf(carried, "arun_0") }));

    expect(derived.text).toContain("5 earlier steps are no longer carried");
  });

  test("a report that does not fit is cut at a claim boundary and says the rest is missing", () => {
    const claims = Array.from({ length: 200 }, (_, index) => `Claim body ${index} `.repeat(10));
    const previous = record({ events: [reportEvent(...claims)] });

    const { text } = deriveThreadContext(previous);

    expect(text.length).toBeLessThanOrEqual(AGENT_THREAD_CONTEXT_MAX_CHARS);
    expect(text).toContain("The rest of this step's report is not shown here.");
    expect(text).toContain("Claim 1:");
    expect(text).not.toContain("Claim 200:");
  });

  test("the spine may not eat the share reserved for the newest report", () => {
    const carried = Array.from({ length: AGENT_THREAD_MAX_STEPS }, (_, index) => ({
      runId: `arun_${index}`,
      objective: "y".repeat(AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS),
    }));
    const previous = record({
      runId: "arun_new",
      thread: threadOf(carried, "arun_0"),
      events: [reportEvent("The one fact that matters")],
    });

    const { text } = deriveThreadContext(previous);

    expect(text).toContain("The one fact that matters");
    expect(text).toContain("no longer shown here");
    expect(text.length).toBeLessThanOrEqual(AGENT_THREAD_CONTEXT_MAX_CHARS);
  });

  test("a predecessor that reported nothing still yields its spine", () => {
    const { text } = deriveThreadContext(record({ objective: "chart those" }));

    expect(text).toContain("Step 1: chart those");
    expect(text).not.toContain("Claim");
    expect(text.endsWith("\n")).toBe(false);
  });

  test("the dropped count is CUMULATIVE, so a long conversation does not keep saying one", () => {
    /*
      Each header carries at most the cap, so the per-derivation figure is 1 forever
      once a conversation passes it. A thirty-step thread reporting that a single step
      was dropped is a number that is only ever right on the first link.
    */
    const carried = Array.from({ length: AGENT_THREAD_MAX_STEPS }, (_, index) => ({
      runId: `arun_${index}`,
      objective: `step ${index}`,
    }));
    const previous = record({
      runId: "arun_new",
      thread: { threadId: "arun_0", steps: carried, text: "", droppedSteps: 7 },
    });

    const derived = deriveThreadContext(previous);

    expect(derived.droppedSteps).toBe(8);
    expect(derived.text).toContain("8 earlier steps are no longer carried");
  });

  test("a conversation that has dropped nothing carries no count at all", () => {
    const derived = deriveThreadContext(record({ objective: "chart those" }));

    expect(derived.droppedSteps).toBeUndefined();
    expect(derived.text).not.toContain("no longer carried");
  });

  test("the spine numbers steps from where the conversation IS, not from what is left of it", () => {
    // A spine that restarts at 1 after steps fell off tells the model this is the
    // first question when it is the ninth.
    const previous = record({
      runId: "arun_new",
      objective: "latest",
      thread: {
        threadId: "arun_0",
        steps: [{ runId: "arun_8", objective: "the eighth question" }],
        text: "",
        droppedSteps: 7,
      },
    });

    const { text } = deriveThreadContext(previous);

    expect(text).toContain("Step 8: the eighth question");
    expect(text).toContain("Step 9: latest");
    expect(text).not.toContain("Step 1:");
  });

  test("a report is cut between ITEMS, so a multi-line claim is never half-carried", () => {
    /*
      A statement and a claim may both carry newlines. Fitting by LINE would keep the
      first line of a multi-line SELECT and then announce the rest was omitted at a
      claim boundary — a sentence about a cut that did not happen there. A partial
      claim is worse than a missing one: the model reads it as complete.
    */
    const multiline = "line one\nline two\nline three that is quite long indeed and keeps going for a while";
    const claims = Array.from({ length: 80 }, (_, index) => `Claim ${index} ${multiline}`);
    const previous = record({ events: [reportEvent(...claims)] });

    const { text } = deriveThreadContext(previous);

    expect(text).toContain(REPORT_CUT_NOTICE_TEXT);
    // Every claim that survived did so WHOLE: no kept claim is missing its own tail.
    for (const claim of claims) {
      const label = claim.slice(0, 40);
      if (text.includes(label)) expect(text).toContain(claim);
    }
  });

  test("a report with no room left is SAID to be absent rather than dropped", () => {
    /*
      The spine's own share can leave nothing behind at a small operator-set budget, and
      a conversation that silently loses its evidence is the one thing this module
      refuses to do everywhere else. The model must not read a spine as the whole of what
      the earlier step produced.
    */
    const carried = Array.from({ length: 6 }, (_, index) => ({
      runId: `arun_${index}`,
      objective: "z".repeat(AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS),
    }));
    const previous = record({
      runId: "arun_new",
      objective: "y".repeat(AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS),
      thread: threadOf(carried, "arun_0"),
      events: [reportEvent("A fact that will not fit")],
    });

    const { text } = deriveThreadContext(previous, 220);

    expect(text.length).toBeLessThanOrEqual(220);
    expect(text).toContain("not shown here");
    expect(text).not.toContain("A fact that will not fit");
  });

  test("an operator-sized budget is honoured over the compiled default", () => {
    const claims = Array.from({ length: 40 }, (_, index) => `Claim body ${index} `.repeat(4));
    const previous = record({ events: [reportEvent(...claims)] });

    const { text } = deriveThreadContext(previous, 600);

    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("The rest of this step's report is not shown here.");
  });
});
