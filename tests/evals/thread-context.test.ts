import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { deriveThreadContext } from "@/lib/agent/thread-context";
import { UNTRUSTED_CONTENT_BEGIN, UNTRUSTED_CONTENT_END } from "@/lib/agent/untrusted-content";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";

/**
 * The mechanism: a run continuing a conversation is handed the steps before it as
 * fenced context, before it does anything.
 *
 * The defect this closes was measured live on 2026-08-15: "and how many of those
 * employees are there in each group?" was answered about DEPARTMENTS, because a run
 * carried no referent for "those groups".
 *
 * What a SCRIPTED model establishes here, and what it cannot. That the conversation
 * reaches the transcript — fenced, before anything is done — is proven directly,
 * because the transcript is what the loop actually sent. That the model RESOLVED a
 * referent against it is NOT: the fixture hands the scripted model the SQL it then
 * asserts came back, so nothing in this path can distinguish a run that resolved the
 * referent from one that did not. That half belongs to a live measurement
 * (`tests/evals/real-model.ts`). These scenarios pin the transport, not the judgement.
 */

const runs: EvalRun[] = [];

beforeEach(() => {
  forgetHeldSnapshots();
});

afterEach(() => {
  for (const run of runs.splice(0)) run.dispose();
  forgetHeldSnapshots();
});

async function open(options: Parameters<typeof openEvalRun>[0] = {}): Promise<EvalRun> {
  const run = await openEvalRun({ engine: "postgres", ...options });
  runs.push(run);
  return run;
}

/**
 * The one fenced block this feature wrote, found by the operation that identifies it.
 *
 * Asserting the BEGIN marker alone would prove nothing: the context snapshot fences
 * the schema inventory into the same transcript, so a thread narrated in the server's
 * own voice would still leave a marker somewhere above. The operation id is what makes
 * the assertion about THIS block, and the slice is what makes it about its inside.
 */
function threadBlockOf(transcript: string): string | null {
  const header = transcript.indexOf("operation agent/thread");
  if (header < 0) return null;
  const begin = transcript.indexOf(UNTRUSTED_CONTENT_BEGIN, header);
  const end = transcript.indexOf(UNTRUSTED_CONTENT_END, begin);
  if (begin < 0 || end < 0) return null;
  return transcript.slice(begin, end);
}

const FIRST_OBJECTIVE = "compare the average salary of employees hired before 1990 with those hired after";

const SALARY_SQL = "SELECT hire_year < 1990 AS before_1990, avg(salary) AS avg_salary FROM employees GROUP BY 1";

const GROUP_COUNT_SQL = "SELECT hire_year < 1990 AS before_1990, count(*) AS headcount FROM employees GROUP BY 1";

describe("a run is told about the conversation it continues", () => {
  test("the second run is handed the first step, inside its own fence, before it does anything", async () => {
    const first = await open({ objective: FIRST_OBJECTIVE });
    const firstDrive = await first.drive([
      callsTool("run_read_query", { sql: SALARY_SQL, rationale: "one read answers the comparison" }),
      reportOn("Before 1990 averaged 41k; after 1990 averaged 38k."),
    ]);
    expect(firstDrive.verdict.outcome).toBe("answered");

    // Derived from the first run's own record, the way the route derives it, so the
    // derivation itself runs here rather than being hand-written past it.
    const thread = deriveThreadContext(await first.record());

    const second = await open({
      objective: "and how many of those employees are there in each group?",
      thread,
    });
    const secondDrive = await second.drive([
      callsTool("run_read_query", { sql: GROUP_COUNT_SQL, rationale: "the groups are the two hire cohorts" }),
      reportOn("The before-1990 group has 12 employees; the after group has 29."),
    ]);

    const transcript = secondDrive.transcripts.join("\n");
    const block = threadBlockOf(transcript);

    expect(block).not.toBeNull();
    expect(block).toContain(`Step 1: ${FIRST_OBJECTIVE}`);
    expect(block).toContain("Claim 1: Before 1990 averaged 41k");
    // The server's instruction stands OUTSIDE the fence; only somebody else's words
    // are inside it.
    expect(block).not.toContain("This run continues a conversation.");
    expect(transcript).toContain("This run continues a conversation.");

    // The scripted model echoes the SQL it was handed, so these two assert the
    // pipeline ran to a cited answer — not that the model resolved the referent.
    expect(secondDrive.modelStatements).toEqual([GROUP_COUNT_SQL]);
    expect(secondDrive.verdict.outcome).toBe("answered");
  });

  test("a third step carries the first step's objective, which is what a middle step cannot pass on", async () => {
    const first = await open({ objective: "count my employees by department" });
    await first.drive([
      callsTool("run_read_query", {
        sql: "SELECT department, count(*) FROM employees GROUP BY 1",
        rationale: "one read",
      }),
      reportOn("There are nine departments."),
    ]);

    const second = await open({ objective: "chart those", thread: deriveThreadContext(await first.record()) });
    await second.drive([
      callsTool("run_read_query", {
        sql: "SELECT department, count(*) FROM employees GROUP BY 1",
        rationale: "re-read to chart",
      }),
      reportOn("The nine departments are shown."),
    ]);

    const third = await open({
      objective: "show the highest paid of those",
      thread: deriveThreadContext(await second.record()),
    });
    const drive = await third.drive([
      callsTool("run_read_query", {
        sql: "SELECT * FROM employees ORDER BY salary DESC LIMIT 1",
        rationale: "one read",
      }),
      reportOn("The highest paid employee is named."),
    ]);

    const block = threadBlockOf(drive.transcripts.join("\n"));

    // The plain statement of intent lives two steps back: the middle step's own
    // objective is a pronoun, so a pairwise chain would have handed this run nothing
    // but "chart those".
    expect(block).toContain("Step 1: count my employees by department");
    expect(block).toContain("Step 2: chart those");
    expect(block).toContain("Claim 1: The nine departments are shown.");
    // The middle step's report is carried; the FIRST step's is not, and the prompt
    // says so outside the fence rather than letting the list imply otherwise.
    expect(block).not.toContain("There are nine departments.");
  });

  test("a run that starts a conversation carries none of one into the prompt", async () => {
    const run = await open({ objective: "and how many of those employees are there in each group?" });
    const drive = await run.drive([
      callsTool("run_read_query", { sql: GROUP_COUNT_SQL, rationale: "count per cohort" }),
      reportOn(),
    ]);
    const transcript = drive.transcripts.join("\n");

    // Non-vacuous: the drive DID run and DID produce a transcript, so the absence
    // below is about the conversation rather than about nothing having happened.
    expect(drive.verdict.outcome).toBe("answered");
    expect(transcript.length).toBeGreaterThan(0);
    expect(threadBlockOf(transcript)).toBeNull();
    expect(transcript).not.toContain("This run continues a conversation.");
  });
});
