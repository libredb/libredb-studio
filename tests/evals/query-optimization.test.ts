import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  type Turn,
  answersProse,
  callsTool,
  correlationIdsIn,
  promptText,
  reportCitingWhatWasOffered,
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

/**
 * What each engine answers an estimating EXPLAIN with, per statement. Keyed on the
 * two engines that answer a composed statement at all — this workflow is offered on
 * no other.
 */
const PLANS: Readonly<Record<"postgres" | "sqlite", (sql: string) => Record<string, unknown>[]>> = {
  postgres: (sql) =>
    sql.includes("emp_no FROM")
      ? [{ "QUERY PLAN": [{ Plan: { "Node Type": "Index Only Scan", "Total Cost": 8.3, "Plan Rows": 1 } }] }]
      : [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 210.5, "Plan Rows": 1000 } }] }],
  sqlite: (sql) =>
    sql.includes("emp_no FROM")
      ? [{ id: 2, parent: 0, notused: 0, detail: "SEARCH employee USING COVERING INDEX ix_last (last_name=?)" }]
      : [{ id: 2, parent: 0, notused: 0, detail: "SCAN employee" }],
};

async function open(engine: "postgres" | "sqlite"): Promise<EvalRun> {
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

      // Two report turns: the run is now asked for the plan its recommendation lacks
      // before that report is allowed through (`shortfallNotice`), and this gate is about
      // what happens when it declines. The bar still closes.
      const drive = await run.drive([
        callsTool("run_read_query", { sql: FAST }, "call_read"),
        recommends(),
        reportOn("The listing reads the whole table."),
        reportOn("The listing reads the whole table."),
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

      /*
        Two report turns, because the run is now NUDGED once before this gate closes: a
        run holding one plan and reaching for the report is asked for the second plan
        instead (`secondPlanBeforeReportNotice`). The script's second report is the model
        ignoring that nudge.

        Which is the point of asserting it here rather than only in the nudge's own
        block. The guarantee the nudge must not break is that it is offered ONCE and then
        stays out of the way: a model that will not take it still reports, and the gate
        still fails the run for what it did not establish. A nudge that could swallow a
        report would be trading this verdict for `no-report`, which is the worse one —
        the same trade a reverted `present_answer` narrowing made earlier.
      */
      const drive = await run.drive([
        callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
        reportOn("The listing reads the whole table."),
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

  /*
    And the bar that gate enforces is STATED, which is the #350/#356 rule the
    `operations` rules already follow and this workflow did not.

    The rules describe both instruments — inspect two plans and call `compare_plans`,
    or recommend an index citing the plan it would change — but describing how a tool
    works is not the same as saying the report is judged on having used one. Measured
    across 25 local models, 6 failed on `no-plan-comparison`, and their ledgers have
    the shape the gate above scripts, character for character: `inspect_schema`,
    `run_read_query`, ONE `inspect_plan`, report. Two evaluated models and
    `qwen3.5:9b` produced identical arcs. They diagnosed the statement correctly and
    stopped, never calling `recommend_change` at all — which is a reasonable place to
    stop if nothing has said otherwise.
  */
  test("a run is told that one plan is not enough, and what would be", async () => {
    const prompts: string[] = [];
    const run = await open("sqlite");

    await run.drive([
      (turn: Turn) => {
        prompts.push(promptText(turn));
        return answersProse("nothing to do")(turn);
      },
    ]);

    expect(prompts[0]).toContain("One plan on its own answers nothing");
  });
});

describe("a run holding two plans and reporting without comparing them is asked once", () => {
  /*
    The measured other half of `no-plan-comparison`, and the reason a stated bar was not
    enough on its own.

    Told that one plan answers nothing, models stopped taking one plan and started taking
    several: two models went to FIVE, a third to
    three. Not one of them then called `compare_plans`. They hold both artifact ids and
    report anyway — so this asks, at the only moment it can still be acted on, and names
    the ids rather than describing where to find them.

    The three conditions mirror `AGENT_PRESENT_BEFORE_REPORT_NOTICE` exactly, and for the
    #350 reason: the workflow must be the one whose verdict wants a comparison, the run
    must HOLD two plans for there to be anything to compare, and a run whose comparison is
    already recorded is not hesitating. A run holding one plan is never told to compare,
    because it cannot.
  */
  test("the report is held back, the two plan ids are named, and the run may still finish", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
      callsTool("inspect_plan", { sql: FAST }, "call_plan_after"),
      reportOn("The listing reads the whole table."),
      comparesPlans(),
      reportOn("The rewrite reaches the same rows by index."),
    ]);

    // The notice carries BOTH ids, because the measured failure is a model that has them.
    const ids = correlationIdsIn(drive.transcripts[3] ?? "");
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(drive.transcripts[3]).toContain("no comparison is recorded");
    // And the run went on to compare and report, so the notice cost it nothing.
    expect(drive.kinds).toContain("plan-comparison");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
  });

  test("a run holding ONE plan is asked for the second one, never for a comparison", async () => {
    /*
      The arm the measurement added, and the distinction it turns on.

      With one plan a comparison is impossible, so asking for one would be the mistake
      this file already records elsewhere: told to do something it cannot, a run neither
      does it nor reports. What it CAN do is take the second plan — or recommend an index
      on the plan it has, which its verdict accepts as the other route — so it is asked
      for those.

      Measured on the clean sweep: `granite4.1:30b` inspected one plan and reported, and
      Another did the same after a refused read. Both had moved UP from
      `no-report` to a real report, and both stopped one call short. The stated bar had
      already moved three other models to three and five plans, so what was missing here was
      the nudge and not the
      rule.
    */
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
      reportOn("The listing reads the whole table."),
      callsTool("inspect_plan", { sql: FAST }, "call_plan_after"),
      comparesPlans(),
      reportOn("The rewrite reaches the same rows by index."),
    ]);

    // The notice lands in the prompt of the turn AFTER the held-back report, which is
    // the point of delivering it instead of running the call.
    expect(drive.transcripts[2]).toContain("only ONE plan");
    // Asked for the second plan, NOT for a comparison it cannot make.
    expect(drive.transcripts[2]).toContain("inspect_plan");
    expect(drive.transcripts[2]).not.toContain("Call compare_plans with before=");
    // And the run finished the arc the nudge pointed at.
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
  });

  test("a run holding no plan IS asked, and the ask is for the reading rather than the comparison", async () => {
    /*
      This test used to assert the opposite — that a run holding no plan is not asked at
      all, "because the nudge would be a lecture". That was a judgement made without the
      measurement, and the measurement overturned it.

      `no-plan-comparison` blocks NINE cells across the models measured at five repeats,
      five of them losing to nothing else. `qwen3:4b` loses this cell four times in five,
      and each losing run has a ledger of four events: started, context captured, report
      composed, finished. No tool was called at all. Those runs are not being lectured for
      a diligence they lack; they never learned that a report here is scored against plans,
      and they ended without anyone telling them.

      What stays true from the original judgement is the shape of the ask. This notice does
      not demand a comparison — a run with no plans cannot make one, and the sibling test
      above holds the two-plan case, where `compareBeforeReportNotice` names the ids. It
      asks for the reading, which is the one call that can start the arc.
    */
    const run = await open("sqlite");

    // Citing the inventory, because a run that read nothing has nothing else to cite.
    const drive = await run.drive([
      reportCitingWhatWasOffered("It is slow because the table is large."),
      callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
      recommends(),
      reportOn("The listing scans the table; an index on last_name would change that."),
    ]);

    expect(drive.transcripts[1]).toContain("inspect_plan");
    expect(drive.transcripts[1]).not.toContain("Call compare_plans with before=");
    expect(drive.verdict.outcome).toBe("answered");
  });

  test("a run that already compared is not asked again", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
      callsTool("inspect_plan", { sql: FAST }, "call_plan_after"),
      comparesPlans(),
      reportOn("The rewrite reaches the same rows by index."),
    ]);

    expect(drive.stopReason).toBe("report-composed");
    expect(drive.verdict.outcome).toBe("answered");
  });
});

describe("an index recommended on no plan at all is asked for one", () => {
  /*
    Measured on `qwen3:8b` and `qwen3:14b`, whose ledgers are the same arc: `inspect_schema`,
    a refused read, then `recommend_change` for an index — and no `inspect_plan` anywhere.
    `verifyQueryOptimizationGoal` accepts an index recommendation only when its evidence
    cites a plan this run inspected, so both scored `no-plan-evidence` having produced a
    recommendation that may well be correct and is not established.

    The sentence comes from the same verifier-derived mechanism as the assessment one, which
    is the point of that mechanism: a new shortfall costs a sentence, not a design.
  */
  test("the report is held back and the run is told to inspect the plan first", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([
      (turn: Turn) =>
        chatToolCallStream(
          "recommend_change",
          JSON.stringify({
            change: "index",
            statement: "CREATE INDEX employee_last_name_idx ON employee (last_name)",
            rationale: "The filtered column looks unindexed.",
            evidence: [{ source: "context-snapshot", fingerprint: /ctx_[a-z0-9]+/.exec(promptText(turn))?.[0] ?? "" }],
          }),
          "call_recommend",
        ),
      // Citing the inventory, because this run has read nothing else yet — which is
      // precisely the state that earns `no-plan-evidence`.
      reportCitingWhatWasOffered("An index on last_name would help."),
      callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
      recommends(),
      reportOn("The listing scans the table; an index on last_name would change that."),
    ]);

    expect(drive.transcripts[2]).toContain("inspect_plan");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
  });

  test("a report resting on no plans at all is held and told to inspect one", async () => {
    /*
      `no-plan-comparison` blocks NINE cells across the measured models, five of them losing
      to nothing else, and it was the one large shortfall with no sentence at all: the
      verdict-preview mechanism had branches for `no-table-profile` and `no-plan-evidence`
      and returned null here, so a run earning it was never told.

      The ledgers show why that matters. `qwen3:4b` loses this cell 4 times in 5, and the
      losing runs have a ledger of exactly four events — started, context captured, report
      composed, finished. No tool was called at all. There was nothing wrong with the run's
      reasoning that a notice would have to argue with; it simply did not know that a report
      here is scored against plans.

      The existing `compareBeforeReportNotice` cannot cover this. It names the two plan ids
      to compare, so it can only fire once a run HOLDS two plans — the case where the model
      has already done the work and stopped one call short. A run that inspected nothing has
      no ids to be named, and needs to be sent to the reading instead.
    */
    const run = await open("sqlite");

    const drive = await run.drive([
      reportCitingWhatWasOffered("The listing is slow because it scans."),
      callsTool("inspect_plan", { sql: SLOW }, "call_plan_before"),
      recommends(),
      reportOn("The listing scans the table; an index on last_name would change that."),
    ]);

    expect(drive.transcripts[1]).toContain("inspect_plan");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-query-optimization.2", unmet: [] });
  });
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
