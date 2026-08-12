import { describe, expect, test } from "bun:test";
import { AGENT_PLANNING_VERIFIER, AGENT_WORKFLOW_GOALS, verifyRunGoal } from "@/lib/agent/goal-verifier";
import type {
  AgentArtifactReference,
  AgentRunEvent,
  AgentRunMode,
  AgentRunRecord,
  AgentRunWorkflowType,
} from "@/lib/agent/types";

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
  workflowType: AgentRunWorkflowType = "investigation",
): Pick<AgentRunRecord, "mode" | "workflowType" | "status" | "events"> {
  return { mode, workflowType, status, events };
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

describe("a query-optimization run is judged by its own artifact as well as the baseline", () => {
  const planComparison: AgentRunEvent = {
    kind: "plan-comparison",
    atMs: 25,
    before: { correlationId: CORRELATION.full, sql: "SELECT * FROM orders", summary: { access: "full-scan" } },
    after: { correlationId: CORRELATION.empty, sql: "SELECT id FROM orders", summary: { access: "index" } },
  };

  test("a cited report AND a plan comparison is an answer", () => {
    const verdict = verifyRunGoal(
      run(
        "agent",
        "succeeded",
        [contextCaptured, completed(CORRELATION.full, 8), planComparison, reportCiting(ARTIFACT(CORRELATION.full))],
        "query-optimization",
      ),
    );

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.1", unmet: [] });
  });

  test("THE GATE: a perfect report with no plan comparison does not answer this workflow's question", () => {
    // #330 T3's gate, stated as it is written: the goal verifier fails the run when
    // its own artifact is absent. This ledger would be a clean `answered` for an
    // investigation — it is the workflow that makes it not one.
    const events = [contextCaptured, completed(CORRELATION.full, 8), reportCiting(ARTIFACT(CORRELATION.full))];

    expect(verifyRunGoal(run("agent", "succeeded", events, "investigation")).outcome).toBe("answered");
    expect(verifyRunGoal(run("agent", "succeeded", events, "query-optimization"))).toEqual({
      outcome: "unanswered",
      verifier: "agent-query-optimization.1",
      unmet: ["no-plan-comparison"],
    });
  });

  test("the baseline dominates: a run that never reported is told THAT, not that it skipped a comparison", () => {
    // Naming the smaller of two problems would send a reader after the wrong one.
    const verdict = verifyRunGoal(
      run("agent", "succeeded", [contextCaptured, completed(CORRELATION.full, 8)], "query-optimization"),
    );

    expect(verdict.unmet).toEqual(["no-report"]);
  });

  test("a comparison does not rescue a report that rests entirely on empty results", () => {
    const verdict = verifyRunGoal(
      run(
        "agent",
        "succeeded",
        [contextCaptured, completed(CORRELATION.empty, 0), planComparison, reportCiting(ARTIFACT(CORRELATION.empty))],
        "query-optimization",
      ),
    );

    expect(verdict.unmet).toEqual(["empty-evidence"]);
  });

  test("an investigation is not held to the optimization bar", () => {
    const verdict = verifyRunGoal(
      run(
        "agent",
        "succeeded",
        [contextCaptured, completed(CORRELATION.full, 8), reportCiting(ARTIFACT(CORRELATION.full))],
        "investigation",
      ),
    );

    expect(verdict.outcome).toBe("answered");
  });

  test("each template is held to its OWN bar, and not to the other's", () => {
    // The same ledger, judged three ways: the artifact a workflow requires is the
    // only thing separating these verdicts.
    const events = [contextCaptured, completed(CORRELATION.full, 8), reportCiting(ARTIFACT(CORRELATION.full))];

    expect(verifyRunGoal(run("agent", "succeeded", events, "query-optimization")).unmet).toEqual([
      "no-plan-comparison",
    ]);
    expect(verifyRunGoal(run("agent", "succeeded", events, "database-assessment")).unmet).toEqual(["no-table-profile"]);
  });
});

describe("the verifier registry", () => {
  test("names one rule per workflow type, so a new workflow cannot inherit another one's bar", () => {
    expect(Object.keys(AGENT_WORKFLOW_GOALS).sort()).toEqual([
      "database-assessment",
      "investigation",
      "query-optimization",
    ]);
  });

  test("every workflow identifies the rule that judged it, so a reader knows what the verdict measured", () => {
    for (const [workflowType, goal] of Object.entries(AGENT_WORKFLOW_GOALS)) {
      expect(verifyRunGoal(run("agent", "succeeded", [], workflowType as AgentRunWorkflowType)).verifier).toBe(
        goal.verifier,
      );
    }
  });

  test("the id and the rule are ONE entry, so a verdict cannot name a bar that was not applied", () => {
    // Found by review on #343: as two separate records, changing an id without
    // changing its rule typechecked. A versioned id whose meaning can drift silently
    // is worse than no id at all.
    for (const goal of Object.values(AGENT_WORKFLOW_GOALS)) {
      expect(typeof goal.verifier).toBe("string");
      expect(typeof goal.verify).toBe("function");
    }
  });

  test("planning is judged by its own rule whatever the run is FOR", () => {
    // Mode decides before the workflow does, for the same reason it does in
    // `selectAgentTools`: a toolless run can never be held to a bar that requires
    // evidence, so a workflow type must not be a way to impose one on it.
    for (const workflowType of Object.keys(AGENT_WORKFLOW_GOALS) as AgentRunWorkflowType[]) {
      const verdict = verifyRunGoal(run("planning", "succeeded", [closing], workflowType));
      expect(verdict).toEqual({ outcome: "answered", verifier: AGENT_PLANNING_VERIFIER, unmet: [] });
    }
  });

  test("the baseline is the same for all three today, and every workflow must still meet it", () => {
    // Composing claims that rest on something the run read is what EVERY workflow
    // has to do; the templates add to it rather than replacing it (#330 T3).
    for (const workflowType of Object.keys(AGENT_WORKFLOW_GOALS) as AgentRunWorkflowType[]) {
      expect(verifyRunGoal(run("agent", "succeeded", [contextCaptured, closing], workflowType)).unmet).toEqual([
        "no-report",
      ]);
    }
  });
});
