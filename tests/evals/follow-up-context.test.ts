import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { UNTRUSTED_CONTENT_BEGIN } from "@/lib/agent/untrusted-content";
import { derivePriorRunContext } from "@/lib/agent/prior-run-context";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";

/**
 * B36, the mechanism: a follow-up run is handed the run it follows as fenced
 * context (`docs/BACKLOG.md` B36).
 *
 * The defect was measured live on 2026-08-15: "and how many of those employees are
 * there in each group?" was answered about DEPARTMENTS, because a run carries no
 * referent for "those groups".
 *
 * What a SCRIPTED model establishes here, and what it cannot. The second run's
 * transcript carrying the first run's objective and report — fenced, before
 * anything is done — is proven directly, because the transcript is what the loop
 * actually sent. That the model RESOLVED "those groups" against it is not: the
 * fixture hands the scripted model the SQL it then asserts came back
 * (`callsTool("run_read_query", { sql: GROUP_COUNT_SQL, ... })`), so nothing in
 * this path can distinguish a run that resolved the referent from one that did
 * not. The referent-resolution half belongs to a live measurement
 * (`tests/evals/real-model.ts`); this scenario pins the transport, not the
 * judgement.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  forgetHeldSnapshots();
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

async function open(options: Parameters<typeof openEvalRun>[0] = {}): Promise<EvalRun> {
  const run = await openEvalRun({ engine: "postgres", ...options });
  runs.push(run);
  return run;
}

const FIRST_OBJECTIVE = "compare the average salary of employees hired before 1990 with those hired after";

const SALARY_SQL = "SELECT hire_year < 1990 AS before_1990, avg(salary) AS avg_salary FROM employees GROUP BY 1";

const GROUP_COUNT_SQL = "SELECT hire_year < 1990 AS before_1990, count(*) AS headcount FROM employees GROUP BY 1";

describe("B36: a follow-up run is told about the run it follows", () => {
  test("the second run is handed the first run's objective and report, fenced, before it does anything", async () => {
    const first = await open({ objective: FIRST_OBJECTIVE });
    const firstDrive = await first.drive([
      callsTool("run_read_query", { sql: SALARY_SQL, rationale: "one read answers the comparison" }),
      reportOn("Before 1990 averaged 41k; after 1990 averaged 38k."),
    ]);
    expect(firstDrive.verdict.outcome).toBe("answered");

    // Derived from the first run's own record, the way the route derives it — so the
    // derivation itself runs here rather than being hand-written past it.
    const prior = derivePriorRunContext(await first.record());

    const second = await open({
      objective: "and how many of those employees are there in each group?",
      priorContext: prior,
    });
    const secondDrive = await second.drive([
      callsTool("run_read_query", { sql: GROUP_COUNT_SQL, rationale: "the groups are the two hire cohorts" }),
      reportOn("The before-1990 group has 12 employees; the after group has 29."),
    ]);

    // The second run was TOLD about the first, fenced, before it did anything.
    const transcript = secondDrive.transcripts.join("\n");
    expect(transcript).toContain(`previous objective: ${FIRST_OBJECTIVE}`);
    expect(transcript).toContain("previous report:");
    expect(transcript).toContain(UNTRUSTED_CONTENT_BEGIN);

    // The scripted model echoes the SQL it was handed, so these two assert the
    // pipeline ran to a cited answer — not that the model resolved the referent.
    expect(secondDrive.modelStatements).toEqual([GROUP_COUNT_SQL]);
    expect(secondDrive.verdict.outcome).toBe("answered");
  });

  test("a follow-up opened with no predecessor carries no prior-run context into the prompt", async () => {
    const run = await open({ objective: "and how many of those employees are there in each group?" });
    const drive = await run.drive([
      callsTool("run_read_query", { sql: GROUP_COUNT_SQL, rationale: "count per cohort" }),
      reportOn(),
    ]);

    expect(drive.transcripts.join("\n")).not.toContain("previous objective:");
    expect(drive.transcripts.join("\n")).not.toContain("previous report:");
  });
});
