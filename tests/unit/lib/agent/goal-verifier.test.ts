import { describe, expect, test } from "bun:test";
import { AGENT_PLANNING_VERIFIER, AGENT_WORKFLOW_GOALS, verifyRunGoal } from "@/lib/agent/goal-verifier";
import type {
  AgentArtifactReference,
  AgentEvidenceReference,
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
  /** A plan this run asked the engine for, under `sql.explain.estimate`. */
  plan: "4f2c9a10-0000-4000-8000-000000000004",
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

/**
 * The three endings a plan run can have, since the deliverable became a statement
 * (the plan-mode SQL-generator design of 2026-08-15).
 *
 * `lecture` is the defect itself, kept verbatim in shape: prose that would read
 * identically against any database in the world, which every field on the ledger
 * called an answer until the `no-statement` shortfall existed.
 */
const closingWithStatement: AgentRunEvent = {
  kind: "closing-statement",
  atMs: 40,
  text: "```postgres\nSELECT title FROM film\n```\n\nRead from `film` because it holds the titles.",
};

const statementDrafted: AgentRunEvent = {
  kind: "plan-statement-drafted",
  atMs: 41,
  sql: "SELECT title FROM film",
  dialect: "postgres",
  readOnly: true,
  identifiers: { kind: "checked", unknownTables: [] },
};

const closingRefusing: AgentRunEvent = {
  kind: "closing-statement",
  atMs: 40,
  text: "NO STATEMENT: the inventory holds no rental history.\n\nWhich table records rentals?",
};

const lecture: AgentRunEvent = {
  kind: "closing-statement",
  atMs: 40,
  text: [
    "1. Start by listing the tables in the database.",
    "2. Inspect the columns of the ones that look relevant.",
    "3. Check the foreign keys to understand how they join.",
    "4. Then write a query that answers the question.",
  ].join("\n"),
};

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
  test("a plan run that drafted a statement is an answer", () => {
    // Planning is toolless by contract, so it can never cite evidence. Judging it
    // by the investigation rule would fail every planning run that did its job.
    // What it CAN produce, since the 2026-08-15 design, is the statement itself.
    const verdict = verifyRunGoal(run("planning", "succeeded", [closingWithStatement, statementDrafted]));

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("an explicit NO STATEMENT: refusal is an answer too", () => {
    // The mode's second legitimate ending: the inventory does not support the
    // question, and saying so is the honest outcome rather than a failure.
    const verdict = verifyRunGoal(run("planning", "succeeded", [closingRefusing]));

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("a four-paragraph lecture with neither outcome is unanswered, however long it is", () => {
    // The defect this rule exists for: a live run on 2026-08-15 answered a question
    // about a real database with a generic inspection plan and scored `answered`,
    // because prose of any length passed.
    const verdict = verifyRunGoal(run("planning", "succeeded", [lecture]));

    expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-planning.1", unmet: ["no-statement"] });
  });

  test("a lecture and a mute run are not conflated", () => {
    // Two different facts about a run, and the sentences a reader gets differ: one
    // said nothing at all, the other said a great deal and delivered nothing.
    expect(verifyRunGoal(run("planning", "succeeded", [lecture])).unmet).toEqual(["no-statement"]);
    expect(verifyRunGoal(run("planning", "succeeded", [])).unmet).toEqual(["no-plan"]);
  });

  test("an operations plan keeps the prose rule, because it has no statement contract", () => {
    // `PLAN_DELIVERABLES.operations` is prose: the workflow reads no schema and
    // composes no SQL, so requiring a statement of it would fail every run that did
    // exactly what the workflow is for.
    const verdict = verifyRunGoal(run("planning", "succeeded", [lecture], "operations"));

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("a cancelled plan run that got as far as prose still reports the cancellation", () => {
    // A user's stop is not a defect of the run, so it is substituted for the missing
    // statement rather than reported as one.
    expect(verifyRunGoal(run("planning", "cancelled", [lecture])).unmet).toEqual(["cancelled"]);
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

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
  });

  test("THE GATE: a perfect report with no plan comparison does not answer this workflow's question", () => {
    // #330 T3's gate, stated as it is written: the goal verifier fails the run when
    // its own artifact is absent. This ledger would be a clean `answered` for an
    // investigation — it is the workflow that makes it not one.
    const events = [contextCaptured, completed(CORRELATION.full, 8), reportCiting(ARTIFACT(CORRELATION.full))];

    expect(verifyRunGoal(run("agent", "succeeded", events, "investigation")).outcome).toBe("answered");
    expect(verifyRunGoal(run("agent", "succeeded", events, "query-optimization"))).toEqual({
      outcome: "unanswered",
      verifier: "agent-query-optimization.2",
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

  /**
   * #356 finding 1: the live run that did everything right and was told it had not
   * answered. It diagnosed the scan, recommended the index that addresses it, and
   * could not compare plans because the "after" plan needs the index to exist —
   * which a read-only run cannot create. It tried, and was refused as it should be.
   */
  describe("an index answers on the plan it diagnosed, because its second plan cannot exist", () => {
    const planRead: AgentRunEvent = {
      kind: "tool-completed",
      atMs: 20,
      stepId: "step_plan",
      artifact: {
        correlationId: CORRELATION.plan,
        runId: "arun_1",
        operationId: "sql.explain.estimate",
        summary: { rowCount: 3, columnNames: ["detail"], elapsedMs: 4 },
      },
    };

    const recommends = (
      change: "index" | "rewrite",
      ...references: readonly { source: "artifact" | "context-snapshot"; id: string }[]
    ): AgentRunEvent => ({
      kind: "recommendation",
      atMs: 28,
      change,
      statement: change === "index" ? "CREATE INDEX salary_amount ON salary (amount)" : "SELECT emp_no FROM salary",
      rationale: "The engine scans salary whole to satisfy the filter.",
      evidence: references.map((reference) =>
        reference.source === "artifact"
          ? ({ source: "artifact", correlationId: reference.id } as const)
          : ({ source: "context-snapshot", fingerprint: reference.id } as const),
      ) as [AgentEvidenceReference, ...AgentEvidenceReference[]],
    });

    const optimization = (events: readonly AgentRunEvent[]) =>
      verifyRunGoal(run("agent", "succeeded", events, "query-optimization"));

    test("a cited report and an index recommendation citing the plan is an answer", () => {
      const verdict = optimization([
        contextCaptured,
        planRead,
        completed(CORRELATION.full, 8),
        recommends("index", ARTIFACT(CORRELATION.plan)),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]);

      expect(verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
    });

    test("an index citing a read rather than a plan is not grounded in what the engine does", () => {
      // The plan is on the ledger; this recommendation does not rest on it. Naming
      // the plan is what ties this index to that access path.
      const verdict = optimization([
        contextCaptured,
        planRead,
        completed(CORRELATION.full, 8),
        recommends("index", ARTIFACT(CORRELATION.full)),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]);

      expect(verdict.unmet).toEqual(["no-plan-evidence"]);
    });

    test("an index citing only the schema snapshot is an index proposed from the shape of the table", () => {
      const verdict = optimization([
        contextCaptured,
        completed(CORRELATION.full, 8),
        recommends("index", SNAPSHOT),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]);

      expect(verdict.unmet).toEqual(["no-plan-evidence"]);
    });

    test("a rewrite is still held to the comparison, because both of ITS plans are readable", () => {
      const verdict = optimization([
        contextCaptured,
        planRead,
        completed(CORRELATION.full, 8),
        recommends("rewrite", ARTIFACT(CORRELATION.plan)),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]);

      expect(verdict.unmet).toEqual(["no-plan-comparison"]);
    });

    test("one grounded index among several answers, and the rest do not have to be", () => {
      const verdict = optimization([
        contextCaptured,
        planRead,
        completed(CORRELATION.full, 8),
        recommends("index", SNAPSHOT),
        recommends("index", ARTIFACT(CORRELATION.plan)),
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]);

      expect(verdict.outcome).toBe("answered");
    });

    test("a comparison still answers on its own, with no recommendation at all", () => {
      const verdict = optimization([
        contextCaptured,
        completed(CORRELATION.full, 8),
        planComparison,
        reportCiting(ARTIFACT(CORRELATION.full)),
      ]);

      expect(verdict.outcome).toBe("answered");
    });
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

describe("an operations run answers on what the ENGINE said about itself", () => {
  const READING = "4f2c9a10-0000-4000-8000-000000000005";

  /** A curated reading this run took, settled under its own operation id. */
  function reading(correlationId: string, rowCount: number): AgentRunEvent {
    return {
      kind: "tool-completed",
      atMs: 20,
      stepId: `step_${correlationId}`,
      artifact: {
        correlationId,
        runId: "arun_1",
        operationId: "db.operations.read",
        summary: { rowCount, columnNames: ["pid", "state", "query"], elapsedMs: 4 },
      },
    };
  }

  const readingAttempted: AgentRunEvent = {
    kind: "tool-invoked",
    atMs: 15,
    stepId: "step_sessions",
    tool: "inspect_operations",
    operationId: "db.operations.read",
  };

  const operations = (events: readonly AgentRunEvent[]) =>
    verifyRunGoal(run("agent", "succeeded", events, "operations"));

  test("a report citing a reading this run took is answered", () => {
    const verdict = operations([readingAttempted, reading(READING, 6), reportCiting(ARTIFACT(READING))]);

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-operations.1", unmet: [] });
  });

  test("the citation half of the rule is enforced where it can fail: at composition", () => {
    // Why this workflow's verifier has no "cited no reading" arm. `composeReportTool`
    // refuses a claim whose evidence names nothing this run produced, and the only
    // citable thing an operations run CAN produce is a reading — it is offered no
    // other tool that settles a step and captures no schema snapshot. So a composed
    // report already is a report citing a reading, and an arm for the opposite would
    // be a verdict advertised to users that no run could ever show.
    expect(AGENT_WORKFLOW_GOALS.operations.verifier).toBe("agent-operations.1");
    expect(operations([readingAttempted, reading(READING, 6), reportCiting(ARTIFACT(READING))]).unmet).toEqual([]);
  });

  test("an EMPTY reading is an answer, not an absence of evidence — the #356 arm", () => {
    // The producibility rule in this workflow's own terms. "No session is blocked"
    // and "the engine reports no slow queries" are what a healthy server says, and
    // they arrive as zero rows. The investigation baseline would call that
    // `empty-evidence` and mark the run unanswered for reporting the truth, which is
    // why this template deliberately does not compose on it.
    const verdict = operations([
      readingAttempted,
      reading(CORRELATION.empty, 0),
      reportCiting(ARTIFACT(CORRELATION.empty)),
    ]);

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-operations.1", unmet: [] });
    // And the same ledger judged as an investigation IS empty-evidence, which is what
    // makes the exception a decision rather than an accident.
    expect(
      verifyRunGoal(
        run("agent", "succeeded", [reading(CORRELATION.empty, 0), reportCiting(ARTIFACT(CORRELATION.empty))]),
      ).unmet,
    ).toEqual(["empty-evidence"]);
  });

  test("a run that composed nothing is told THAT, not that it cited no reading", () => {
    expect(operations([readingAttempted, reading(READING, 6), closing]).unmet).toEqual(["no-report"]);
  });

  test("a cancelled run without a report reports the cancellation instead", () => {
    expect(verifyRunGoal(run("agent", "cancelled", [readingAttempted], "operations")).unmet).toEqual(["cancelled"]);
  });
});

describe("a data-analysis run answers when it also produced something to show", () => {
  const ANSWER = "4f2c9a10-0000-4000-8000-000000000006";

  const answerComposed: AgentRunEvent = {
    kind: "answer-composed",
    atMs: 25,
    sql: "SELECT region, sum(net_total) AS net_total FROM orders GROUP BY region",
    artifact: artifact(ANSWER, 4),
    presentation: { kind: "table" },
    handover: "none",
  };

  const analysis = (events: readonly AgentRunEvent[]) =>
    verifyRunGoal(run("agent", "succeeded", events, "data-analysis"));

  test("the baseline plus an answer is answered", () => {
    const verdict = analysis([contextCaptured, completed(ANSWER, 4), answerComposed, reportCiting(ARTIFACT(ANSWER))]);

    expect(verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
  });

  test("a report with no answer to show falls short on the template's own artifact", () => {
    const verdict = analysis([contextCaptured, completed(ANSWER, 4), reportCiting(ARTIFACT(ANSWER))]);

    expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-data-analysis.1", unmet: ["no-answer"] });
  });

  test("the baseline dominates, so a run that composed nothing is told THAT", () => {
    // Composition, not replacement: naming the smaller of two problems is the
    // mistake composing avoids. A run that never reported has not become a run that
    // merely skipped an answer.
    expect(analysis([contextCaptured, completed(ANSWER, 4), closing]).unmet).toEqual(["no-report"]);
    expect(
      analysis([contextCaptured, completed(CORRELATION.empty, 0), reportCiting(ARTIFACT(CORRELATION.empty))]).unmet,
    ).toEqual(["empty-evidence"]);
  });

  test("presenting a table is worth exactly what presenting a chart is", () => {
    // §3.4: a one-row result, a single number and a result with no numeric column
    // are complete answers. A rule that only accepted a chart would be #356 again —
    // stated in terms of an artifact only some of the valid answers can produce.
    const chart: AgentRunEvent = {
      ...answerComposed,
      presentation: {
        kind: "chart",
        spec: { type: "bar", x: "region", y: ["net_total"], caption: "Net total by region." },
      },
    };

    expect(analysis([contextCaptured, completed(ANSWER, 4), chart, reportCiting(ARTIFACT(ANSWER))]).outcome).toBe(
      "answered",
    );
  });

  /**
   * The link between the two halves of an analytical answer (#373 review).
   *
   * The baseline asks for a cited report and the template asks for a presented
   * result, and until this arm nothing tied them together: a run could present
   * artifact A while every claim cited artifact B and still score `answered` —
   * unrelated prose beside a chart, which is exactly the shape of run this verifier
   * exists to see.
   */
  describe("the report has to be about the result the run presented", () => {
    const OTHER = "4f2c9a10-0000-4000-8000-000000000007";

    test("a report citing some other result the run read is not an answer to the presentation", () => {
      const verdict = analysis([
        contextCaptured,
        completed(ANSWER, 4),
        completed(OTHER, 3),
        answerComposed,
        reportCiting(ARTIFACT(OTHER)),
      ]);

      expect(verdict).toEqual({ outcome: "unanswered", verifier: "agent-data-analysis.1", unmet: ["answer-uncited"] });
    });

    test("one claim among several is enough: the rule is a link, not a restriction on the report", () => {
      // A report says more than what the chart shows, and it should. What is required
      // is that SOMETHING in it rests on the result being presented, which is what the
      // model can produce in the order the tools are called: it holds the answer's
      // correlation id, having just passed it to present_answer.
      const verdict = analysis([
        contextCaptured,
        completed(ANSWER, 4),
        completed(OTHER, 3),
        answerComposed,
        reportCiting(ARTIFACT(OTHER), ARTIFACT(ANSWER)),
      ]);

      expect(verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
    });

    test("a claim resting on the schema snapshot alone does not link the report to the answer", () => {
      expect(analysis([contextCaptured, completed(ANSWER, 4), answerComposed, reportCiting(SNAPSHOT)]).unmet).toEqual([
        "answer-uncited",
      ]);
    });

    test("the missing answer dominates the missing link, so the larger problem is the one named", () => {
      // Composition again: a run with no presentation at all is told THAT rather than
      // told its report failed to cite a presentation it never made.
      expect(analysis([contextCaptured, completed(ANSWER, 4), reportCiting(SNAPSHOT)]).unmet).toEqual(["no-answer"]);
    });
  });

  test("a run answering purely from the schema snapshot is unanswered, deliberately", () => {
    // The rule's stated blind spot, asserted so that it is a decision on the record
    // rather than an accident nobody measured: an analysis that read no data is not
    // an analysis, and the remedy for a schema question is the `investigation`
    // workflow rather than a wider notion of evidence.
    const schemaOnly = [contextCaptured, reportCiting(SNAPSHOT)];

    expect(analysis(schemaOnly).unmet).toEqual(["no-answer"]);
    expect(verifyRunGoal(run("agent", "succeeded", schemaOnly)).unmet).toEqual([]);
  });

  test("a cancelled run without a report reports the cancellation instead", () => {
    expect(verifyRunGoal(run("agent", "cancelled", [contextCaptured], "data-analysis")).unmet).toEqual(["cancelled"]);
  });
});

describe("the verifier registry", () => {
  test("names one rule per workflow type, so a new workflow cannot inherit another one's bar", () => {
    expect(Object.keys(AGENT_WORKFLOW_GOALS).sort()).toEqual([
      "data-analysis",
      "database-assessment",
      "investigation",
      "operations",
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
    // Each workflow is given the ending ITS deliverable asks for — a statement
    // everywhere but `operations`, whose plan deliverable is prose by decision — so
    // this asserts which RULE judged the run rather than re-asserting the bar.
    for (const workflowType of Object.keys(AGENT_WORKFLOW_GOALS) as AgentRunWorkflowType[]) {
      const events =
        workflowType === "operations" ? [lecture] : ([closingWithStatement, statementDrafted] as AgentRunEvent[]);
      const verdict = verifyRunGoal(run("planning", "succeeded", events, workflowType));
      expect(verdict, workflowType).toEqual({ outcome: "answered", verifier: AGENT_PLANNING_VERIFIER, unmet: [] });
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
