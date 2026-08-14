import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  type Turn,
  answersProse,
  callsTool,
  correlationIdsIn,
  reportOn,
} from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";

/**
 * The `query-optimization` template, driven end to end on both reference engines
 * (#330 T3).
 *
 * The gate this file exists for is the second half of T3's: **the goal verifier
 * fails the run when the template's own artifact is absent.** The last describe
 * block is that, and it is asserted against a run that would be a clean `answered`
 * for an investigation — it is the workflow, not the quality of the report, that
 * makes it unanswered.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

const SLOW = "SELECT * FROM employee WHERE last_name = 'Facello'";
const FAST = "SELECT emp_no FROM employee WHERE last_name = 'Facello'";

/** What each engine answers an estimating EXPLAIN with, per statement. */
const PLANS: Readonly<Record<EvalEngine, (sql: string) => Record<string, unknown>[]>> = {
  postgres: (sql) =>
    sql.includes("emp_no FROM")
      ? [{ "QUERY PLAN": [{ Plan: { "Node Type": "Index Only Scan", "Total Cost": 8.3, "Plan Rows": 1 } }] }]
      : [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 210.5, "Plan Rows": 1000 } }] }],
  sqlite: (sql) =>
    sql.includes("emp_no FROM")
      ? [{ id: 2, parent: 0, notused: 0, detail: "SEARCH employee USING COVERING INDEX ix_last (last_name=?)" }]
      : [{ id: 2, parent: 0, notused: 0, detail: "SCAN employee" }],
};

async function open(engine: EvalEngine): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    workflowType: "query-optimization",
    objective: "Why is the employee listing query slow?",
    answer: async (sql) => {
      const rows = sql.startsWith("EXPLAIN") ? PLANS[engine](sql) : [{ emp_no: 10001 }];
      return { rows, fields: Object.keys(rows[0] ?? {}), rowCount: rows.length, executionTime: 3 };
    },
  });
  runs.push(run);
  return run;
}

/** Compares the two plans this run has inspected, by the ids the transcript carries. */
const comparesPlans =
  () =>
  (turn: Turn): Response => {
    const [before, after] = correlationIdsIn(turn.transcript);
    if (before === undefined || after === undefined) {
      throw new Error(
        `expected two plan artifacts in the transcript, got ${JSON.stringify(correlationIdsIn(turn.transcript))}`,
      );
    }
    return chatToolCallStream("compare_plans", JSON.stringify({ before, after }), "call_compare");
  };

const recommends =
  () =>
  (turn: Turn): Response =>
    chatToolCallStream(
      "recommend_change",
      JSON.stringify({
        change: "index",
        statement: "CREATE INDEX employee_last_name_idx ON employee (last_name)",
        rationale: "The filtered column has no index, so the engine reads the table whole.",
        evidence: [{ source: "artifact", correlationId: correlationIdsIn(turn.transcript)[0] }],
      }),
      "call_recommend",
    );

const optimizationArc = () => [
  callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
  callsTool("inspect_plan", { sql: FAST }, "call_plan_after"),
  comparesPlans(),
  recommends(),
  reportOn("The listing reads the whole table because last_name is unindexed."),
];

describe("the optimization arc, on both reference engines", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: inspects both plans, compares them, recommends, and answers`, async () => {
      const run = await open(engine);

      const drive = await run.drive(optimizationArc());

      expect(drive.kinds).toEqual([
        "run-started",
        "context-captured",
        "statement-drafted",
        "tool-invoked",
        "tool-completed",
        "statement-drafted",
        "tool-invoked",
        "tool-completed",
        "plan-comparison",
        "recommendation",
        "report-composed",
        "run-finished",
      ]);
      expect(drive.status).toBe("succeeded");
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
    });

    test(`${engine}: the comparison records what the engine's own plan said`, async () => {
      const run = await open(engine);

      const drive = await run.drive(optimizationArc());

      const comparison = drive.events.find((event) => event.kind === "plan-comparison");
      if (comparison?.kind !== "plan-comparison") throw new Error("expected a plan comparison");
      expect(comparison.before.summary.access).toBe("full-scan");
      expect(comparison.after.summary.access).toBe("index");
      // The statements come from the ledger, not from the model's arguments.
      expect(comparison.before.sql).toBe(SLOW);
      expect(comparison.after.sql).toBe(FAST);
    });

    test(`${engine}: the recommendation is recorded and never executed`, async () => {
      const run = await open(engine);

      const drive = await run.drive(optimizationArc());

      const recommendation = drive.events.find((event) => event.kind === "recommendation");
      if (recommendation?.kind !== "recommendation") throw new Error("expected a recommendation");
      expect(recommendation.change).toBe("index");
      // The DDL reached no database: every statement this run sent was a read or a
      // plan inspection.
      for (const statement of drive.modelStatements) expect(statement).not.toContain("CREATE INDEX");
      expect(drive.modelStatements).toHaveLength(2);
    });
  }

  test("postgres carries the engine's estimates; SQLite reports none, and none is invented", async () => {
    const postgres = await open("postgres");
    const sqlite = await open("sqlite");

    const pgComparison = (await postgres.drive(optimizationArc())).events.find((e) => e.kind === "plan-comparison");
    const liteComparison = (await sqlite.drive(optimizationArc())).events.find((e) => e.kind === "plan-comparison");

    if (pgComparison?.kind !== "plan-comparison" || liteComparison?.kind !== "plan-comparison") {
      throw new Error("expected both comparisons");
    }
    expect(pgComparison.before.summary).toEqual({ access: "full-scan", estimatedRows: 1000, estimatedCost: 210.5 });
    // `EXPLAIN QUERY PLAN` reports no cost and no row estimate at all.
    expect(liteComparison.before.summary).toEqual({ access: "full-scan" });
  });
});

/**
 * The arc a live run actually takes when the answer is an index (#356).
 *
 * On 2026-08-12 a run against the SQLite sample diagnosed the scan, recommended
 * `CREATE INDEX idx_salary_amount_emp`, composed an accurate report — and was
 * scored `unanswered`, because the rule asked for a comparison whose second plan
 * would need the index to exist. It tried that too, and was refused as it should
 * be. This block is that run, both ways round.
 */
describe("an index answers on the plan it diagnosed", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: one plan, an index citing it, and a cited report is an answer`, async () => {
      const run = await open(engine);

      const drive = await run.drive([
        callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
        recommends(),
        reportOn("The listing reads the whole table."),
      ]);

      expect(drive.status).toBe("succeeded");
      expect(drive.stopReason).toBe("report-composed");
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
      // And it stays read-only: the DDL it proposed reached no database.
      for (const statement of drive.modelStatements) expect(statement).not.toContain("CREATE INDEX");
    });

    test(`${engine}: an index citing a read rather than a plan does not answer`, async () => {
      // The relaxation is about which artifact grounds the index, not about whether
      // one has to. Nothing here asked the engine how it reaches its rows.
      const run = await open(engine);

      const drive = await run.drive([
        callsTool("run_read_query", { sql: FAST }, "call_read"),
        recommends(),
        reportOn("The listing reads the whole table."),
      ]);

      expect(drive.verdict).toEqual({
        outcome: "unanswered",
        verifier: "agent-query-optimization.2",
        unmet: ["no-plan-evidence"],
      });
    });
  }
});

describe("THE GATE: the verifier fails the run when the template's own artifact is absent", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: a competent, fully cited report that proposes nothing does not answer`, async () => {
      const run = await open(engine);

      const drive = await run.drive([
        callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
        reportOn("The listing reads the whole table."),
      ]);

      expect(drive.status).toBe("succeeded");
      expect(drive.stopReason).toBe("report-composed");
      expect(drive.verdict).toEqual({
        outcome: "unanswered",
        verifier: "agent-query-optimization.2",
        unmet: ["no-plan-comparison"],
      });
    });
  }
});

describe("the tools belong to the workflow, not to the model", () => {
  test("an investigation asking to compare plans is told there is no such tool", async () => {
    const run = await openEvalRun({ objective: "Why is it slow?" });
    runs.push(run);

    const drive = await run.drive([
      (turn: Turn) => {
        void turn;
        return chatToolCallStream("compare_plans", JSON.stringify({ before: "a", after: "b" }), "call_compare");
      },
      answersProse("There is nothing here I can compare."),
    ]);

    // Refused by the OFFERED set, before any argument was looked at — and the run
    // continued rather than failing, because a tool the model invented is a model
    // mistake and not a broken run.
    expect(drive.transcripts[1]).toContain("There is no tool called");
    expect(drive.kinds).not.toContain("plan-comparison");
  });
});

describe("a drive that dies after recording a comparison does not make it twice", () => {
  // Found by review on #344: both new events are durable and non-terminal, so a
  // resumed run that is not told about them re-derives them — and after the artifact
  // store has released the plans it is refused instead, sent after a mistake it did
  // not make.
  test("the resumed run is told what it already compared and already recommended", async () => {
    const run = await open("postgres");

    await expect(
      run.drive([
        callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
        callsTool("inspect_plan", { sql: FAST }, "call_plan_after"),
        comparesPlans(),
        recommends(),
      ]),
    ).rejects.toThrow(/died before turn/);

    const resumed = await run.drive([reportOn("The listing reads the whole table.")]);

    const firstTurn = resumed.transcripts[0] ?? "";
    expect(firstTurn).toContain("Two plans were already compared");
    expect(firstTurn).toContain("must not be made again");
    expect(firstTurn).toContain("was already recommended");
    // And the run still answers: the comparison it needs is on its own ledger.
    expect(resumed.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
  });
});
