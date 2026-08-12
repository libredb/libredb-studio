import { describe, expect, test } from "bun:test";
import { AGENT_GOAL_VERIFIERS, verifyRunGoal } from "@/lib/agent/goal-verifier";
import type { AgentArtifactReference, AgentRunEvent, AgentRunMode, AgentRunRecord } from "@/lib/agent/types";

/**
 * The goal verifier (#330 T1): the thing that can see a run which finished
 * without answering.
 *
 * Every case below is a LEDGER, because that is what the criterion is about. Nine
 * live runs on 2026-08-12 (#341) ended with green unit tests, 100% line coverage
 * and a rail that rendered, and not one of them produced a report — the code ran
 * correctly, and nothing in the record said the run had said nothing. `stopReason`
 * (#338) closed half of it: it separates "the model composed a report" from "the
 * model stopped". What it cannot see is a run that composed a report and still
 * answered nothing, which is the second fixture group here.
 */

const CORRELATION = {
  full: "4f2c9a10-0000-4000-8000-000000000001",
  empty: "4f2c9a10-0000-4000-8000-000000000002",
  alsoEmpty: "4f2c9a10-0000-4000-8000-000000000003",
} as const;

const SNAPSHOT_FINGERPRINT = "ctx_2f0a";

function artifact(correlationId: string, rowCount: number): AgentArtifactReference {
  return {
    correlationId,
    runId: "arun_1",
    operationId: "sql.query.read",
    summary: { rowCount, columnNames: ["department", "headcount"], elapsedMs: 7 },
  };
}

const contextCaptured: AgentRunEvent = {
  kind: "context-captured",
  atMs: 10,
  fingerprint: SNAPSHOT_FINGERPRINT,
  tableCount: 8,
};

function completed(correlationId: string, rowCount: number): AgentRunEvent {
  return {
    kind: "tool-completed",
    atMs: 20,
    stepId: `step_${correlationId}`,
    artifact: artifact(correlationId, rowCount),
  };
}

function reportCiting(
  ...references: readonly { source: "artifact" | "context-snapshot"; id: string }[]
): AgentRunEvent {
  return {
    kind: "report-composed",
    atMs: 30,
    claims: [
      {
        claim: "Engineering has the most employees, at 41.",
        evidence: references.map((reference) =>
          reference.source === "artifact"
            ? ({ source: "artifact", correlationId: reference.id } as const)
            : ({ source: "context-snapshot", fingerprint: reference.id } as const),
        ) as [
          { source: "artifact"; correlationId: string } | { source: "context-snapshot"; fingerprint: string },
          ...({ source: "artifact"; correlationId: string } | { source: "context-snapshot"; fingerprint: string })[],
        ],
      },
    ],
  };
}

const closing: AgentRunEvent = { kind: "closing-statement", atMs: 40, text: "I would start with the orders table." };

function run(
  mode: AgentRunMode,
  status: AgentRunRecord["status"],
  events: readonly AgentRunEvent[],
): Pick<AgentRunRecord, "mode" | "status" | "events"> {
  return { mode, status, events };
}

const ARTIFACT = (id: string) => ({ source: "artifact" as const, id });
const SNAPSHOT = { source: "context-snapshot" as const, id: SNAPSHOT_FINGERPRINT };

describe("an agent run answers when it composed a report backed by something it read", () => {
  test("a report citing an artifact that returned rows is answered", () => {
    const verdict = verifyRunGoal(
      run("agent", "succeeded", [
        contextCaptured,
        completed(CORRELATION.full, 8),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]),
    );

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1", unmet: [] });
  });

  test("a report citing only the schema snapshot is answered, because some questions are answerable from the schema", () => {
    const verdict = verifyRunGoal(run("agent", "succeeded", [contextCaptured, reportCiting(SNAPSHOT)]));

    expect(verdict.outcome).toBe("answered");
    expect(verdict.unmet).toEqual([]);
  });

  test("one empty result among the citations does not make the report empty", () => {
    const verdict = verifyRunGoal(
      run("agent", "succeeded", [
        contextCaptured,
        completed(CORRELATION.empty, 0),
        completed(CORRELATION.full, 8),
        reportCiting(ARTIFACT(CORRELATION.empty), ARTIFACT(CORRELATION.full)),
      ]),
    );

    expect(verdict.outcome).toBe("answered");
  });

  test("a citation the ledger cannot resolve is not counted as empty, because emptiness was never established", () => {
    // `composeReportTool` refuses an invented correlation id, so this shape cannot
    // come out of the run loop. It can come out of a hand-written or older ledger,
    // and guessing "empty" about a result nobody has seen would be the verifier
    // inventing evidence of its own.
    const verdict = verifyRunGoal(run("agent", "succeeded", [contextCaptured, reportCiting(ARTIFACT("never-read"))]));

    expect(verdict.outcome).toBe("answered");
  });
});

describe("an agent run that finished without answering says so", () => {
  test("a run that stopped without composing a report is unanswered", () => {
    // #341 F2, exactly: the run inspected the schema, ran its reads, and finished
    // `succeeded` with the answer nowhere.
    const verdict = verifyRunGoal(
      run("agent", "succeeded", [contextCaptured, completed(CORRELATION.full, 8), closing]),
    );

    expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] });
  });

  test("a run whose report rests entirely on empty results is unanswered", () => {
    // The defect no field in this codebase can currently see: status `succeeded`,
    // `stopReason: report-composed`, citations that all verify — and `0 rows`
    // presented as the answer.
    const verdict = verifyRunGoal(
      run("agent", "succeeded", [
        contextCaptured,
        completed(CORRELATION.empty, 0),
        completed(CORRELATION.alsoEmpty, 0),
        reportCiting(ARTIFACT(CORRELATION.empty), ARTIFACT(CORRELATION.alsoEmpty)),
      ]),
    );

    expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["empty-evidence"] });
  });

  test("a run that ran out of turns without reporting is unanswered", () => {
    const verdict = verifyRunGoal(run("agent", "failed", [contextCaptured, completed(CORRELATION.full, 8)]));

    expect(verdict.outcome).toBe("unanswered");
    expect(verdict.unmet).toEqual(["no-report"]);
  });

  test("a cancelled run is unanswered because it was stopped, not because it failed to report", () => {
    // A user's stop is not a defect of the run, and reporting it as one would make
    // every cancellation look like a model that would not answer.
    const verdict = verifyRunGoal(run("agent", "cancelled", [contextCaptured, completed(CORRELATION.full, 8)]));

    expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["cancelled"] });
  });

  test("a cancellation that arrived after the report still counts as answered", () => {
    const verdict = verifyRunGoal(
      run("agent", "cancelled", [
        contextCaptured,
        completed(CORRELATION.full, 8),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]),
    );

    expect(verdict.outcome).toBe("answered");
  });

  test("a report with no claims at all is unanswered", () => {
    const verdict = verifyRunGoal(
      run("agent", "succeeded", [contextCaptured, { kind: "report-composed", atMs: 30, claims: [] }]),
    );

    expect(verdict.unmet).toEqual(["no-report"]);
  });
});

describe("a planning run is judged by what planning mode can produce", () => {
  test("a plan in prose is an answer", () => {
    // Planning is toolless by contract, so it can never cite evidence. Judging it
    // by the investigation rule would fail every planning run that did its job.
    const verdict = verifyRunGoal(run("planning", "succeeded", [closing]));

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("a planning run that said nothing is unanswered", () => {
    // #341 F1: the mute planning run, whose entire ledger was three events.
    const verdict = verifyRunGoal(run("planning", "succeeded", []));

    expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-planning.1", unmet: ["no-plan"] });
  });

  test("a cancelled planning run reports the cancellation rather than a missing plan", () => {
    const verdict = verifyRunGoal(run("planning", "cancelled", []));

    expect(verdict.unmet).toEqual(["cancelled"]);
  });
});

describe("the verifier registry", () => {
  test("names one rule per run mode, so a new mode cannot inherit another mode's bar", () => {
    expect(Object.keys(AGENT_GOAL_VERIFIERS).sort()).toEqual(["agent", "planning"]);
  });

  test("every rule identifies itself in its own verdict, so a reader knows what judged the run", () => {
    for (const [mode, verifierId] of Object.entries(AGENT_GOAL_VERIFIERS)) {
      expect(verifyRunGoal(run(mode as AgentRunMode, "succeeded", [])).verifier).toBe(verifierId);
    }
  });
});
