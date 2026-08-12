import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DEPARTMENTS, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { answersProse, callsTool, reportOn, reportOnAll } from "../isolated/fixtures/agent-scripted-model";

/**
 * The strategy defects #341 observed against a real model, as scripted scenarios
 * (#330 T1).
 *
 * These are the corpus this milestone's gate is measured against, and every one of
 * them was seen rather than imagined. Each test asserts what the harness OBSERVES,
 * with the desired behaviour named in the test's own words — a permanently red test
 * cannot be committed, and a corpus that asserted the desired behaviour would be a
 * suite nobody could merge rather than a measurement anybody could read.
 *
 * The gate itself was demonstrated before this file took its present shape: with
 * every assertion written as `expect(drive.verdict.outcome).toBe("answered")`, all
 * three failed with `Received: "unanswered"`. A harness that cannot fail on a known
 * defect is not measuring anything, so it was made to fail first.
 *
 * What the defects have in common is the thing that made them invisible for a
 * morning: **the code ran correctly in every one of them.** No exception, no denial,
 * no broken invariant. The run simply did not answer, and until `verifyRunGoal`
 * there was no field in which that fact existed.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  // The audited execution layer writes one JSON line per operation to stdout, and a
  // scenario makes a dozen. Silenced so a failure is readable.
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

async function open(options: Parameters<typeof openEvalRun>[0] = {}): Promise<EvalRun> {
  const run = await openEvalRun(options);
  runs.push(run);
  return run;
}

const AGGREGATE = "SELECT department, count(*) AS headcount FROM employees GROUP BY department ORDER BY 2 DESC";
const verifyOne = (department: string): string =>
  `SELECT count(*) AS headcount FROM employees WHERE department = '${department}'`;

const emptyResult = async () => ({ rows: [], fields: ["department"], rowCount: 0, executionTime: 3 });

describe("#341 F5: the model re-verifies what one query already gave it, until the turns run out", () => {
  /*
    The defect a simple question already reproduces on merged main: "which department
    has the most employees?" obtained all eight counts in ONE statement, then went
    back and counted each department individually, and reached `AGENT_MAX_MODEL_TURNS`
    with the answer it already held never written down.

    Desired: the run answers from the aggregate it already has, in far fewer turns.
    Observed: the turn ceiling, and nothing said.
  */
  test("the run reaches the turn ceiling having already held the answer since its first read", async () => {
    const run = await open({ objective: "Which department has the most employees?" });

    const drive = await run.drive(
      [
        callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
        ...DEPARTMENTS.map((department, index) =>
          callsTool("run_read_query", { sql: verifyOne(department), rationale: "double-check" }, `call_${index}`),
        ),
      ],
      { maxTurns: DEPARTMENTS.length + 1 },
    );

    expect(drive.status).toBe("failed");
    expect(drive.stopReason).toBe("turn-limit");
    expect(drive.verdict).toEqual({ outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] });
  });

  test("the wasted work is visible as statements, so the cost of the strategy can be counted", async () => {
    const run = await open({ objective: "Which department has the most employees?" });

    const drive = await run.drive(
      [
        callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
        ...DEPARTMENTS.map((department, index) =>
          callsTool("run_read_query", { sql: verifyOne(department), rationale: "double-check" }, `call_${index}`),
        ),
      ],
      { maxTurns: DEPARTMENTS.length + 1 },
    );

    // One statement would have done. Eight more were spent re-establishing it, and
    // every one of them is a real read against the user's database.
    expect(drive.modelStatements).toHaveLength(DEPARTMENTS.length + 1);
    expect(drive.modelStatements[0]).toBe(AGGREGATE);
  });
});

describe("#341 F2: the run investigates competently and finishes without composing a report", () => {
  /*
    The run that inspected the schema, ran the query it needed, and ended `succeeded`
    with the answer nowhere. `stopReason: model-stopped` (#338) is what made the
    ENDING legible; the verdict is what makes the OUTCOME legible.

    Desired: the model calls compose_report with what it found.
    Observed: prose to the caller, and a ledger with no claim in it.
  */
  test("a competent investigation that never reports is succeeded, and unanswered", async () => {
    const run = await open();

    const drive = await run.drive([
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
      answersProse("Engineering has the most employees, at 41."),
    ]);

    expect(drive.status).toBe("succeeded");
    expect(drive.stopReason).toBe("model-stopped");
    expect(drive.verdict).toEqual({ outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] });
  });

  test("the work it did is on the ledger, so a partial answer is not lost with the missing report", async () => {
    const run = await open();

    const drive = await run.drive([
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
      answersProse("Engineering has the most employees, at 41."),
    ]);

    expect(drive.kinds).toEqual([
      "run-started",
      "context-captured",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      "closing-statement",
      "run-finished",
    ]);
  });
});

describe("a run answers an empty result set as if 0 rows were the answer", () => {
  /*
    The sharpest of the three, and the reason a verdict has to exist at all: this run
    composes a report, its citations verify against its own ledger, and it stops with
    `stopReason: report-composed`. There is no field in this ledger — before the
    verdict — in which it differs from a run that answered.

    Desired: an empty result is deepened, or stated as uncertainty.
    Observed: `0 rows` presented as the finding.
  */
  test("the report composes, the citations verify, and the run answered nothing", async () => {
    const run = await open({ answer: emptyResult });

    const drive = await run.drive([
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
      reportOnAll("No department has any employees."),
    ]);

    expect(drive.status).toBe("succeeded");
    expect(drive.stopReason).toBe("report-composed");
    expect(drive.verdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-investigation.1",
      unmet: ["empty-evidence"],
    });
  });

  test("it is indistinguishable from a run that answered, in every terminal field that existed before the verdict", async () => {
    // The whole argument for #330 T1, as an assertion. If this test ever fails
    // because the two ledgers have started to differ somewhere else, that is good
    // news and this test should be the thing that reports it.
    const good = await open();
    const empty = await open({ answer: emptyResult });

    const answered = await good.drive([
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
      reportOn("Engineering has the most employees, at 41."),
    ]);
    const hollow = await empty.drive([
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "count per department" }),
      reportOnAll("No department has any employees."),
    ]);

    expect(hollow.status).toBe(answered.status);
    expect(hollow.stopReason).toBe(answered.stopReason);
    expect(hollow.kinds).toEqual(answered.kinds);
    // And the one field in which they do differ.
    expect(answered.verdict.outcome).toBe("answered");
    expect(hollow.verdict.outcome).toBe("unanswered");
  });

  test("an empty read the report does NOT rest on is not held against the run", async () => {
    // The rule has to be about what the claims RESTED on, not about whether the run
    // ever saw an empty result: a probe that legitimately returns nothing is normal
    // investigative work, and failing a run for it would punish the deepening the
    // rule is asking for.
    let call = 0;
    const run = await open({
      answer: async () =>
        (call += 1) === 1
          ? { rows: [], fields: ["department"], rowCount: 0, executionTime: 3 }
          : { rows: [{ department: "engineering" }], fields: ["department"], rowCount: 1, executionTime: 3 },
    });

    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT department FROM employees WHERE department IS NULL" }),
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "the real question" }, "call_2"),
      // `reportOn` cites the FIRST correlation id in the transcript, which is the
      // empty probe; `reportOnAll` cites both. Both are asserted below.
      reportOnAll("Engineering has the most employees, and no row has a null department."),
    ]);

    expect(drive.verdict.outcome).toBe("answered");
  });
});
