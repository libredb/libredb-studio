import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  answersProse,
  callsTool,
  reportCitingWhatWasOffered,
  reportOn,
  reportOnAll,
} from "../isolated/fixtures/agent-scripted-model";
import { CASES, openCaseRun, summarise } from "./real-model";

/**
 * What the real-model eval's `empty-result` case is ABLE to catch (#331 T7).
 *
 * The case exists for #341's third defect: a run that treats an empty result as an
 * answer. It costs a credential and a model call, so what it can detect was, until
 * this file, established only by reading it — and a repair to its scripted world
 * silently took the detection away. The world now answers a COUNT of the missing
 * rows as one row saying zero, which is what a real engine returns and what a real
 * model needs to reach an answer at all; but `empty-evidence` fires only when EVERY
 * cited result came back empty, so a run reporting `0` while citing that count was
 * recorded `answered`, and the job's exit code moved to 0 with it.
 *
 * These are the same case objects the eval runs, imported rather than copied: a
 * second world in this file would prove something about the copy. Only the model is
 * different — scripted here, live there — which is the harness's own rule.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  // The audited execution layer writes one JSON line per operation to stdout.
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

const caseNamed = (name: string) => {
  const testCase = CASES.find((entry) => entry.name === name);
  if (!testCase) throw new Error(`no eval case named ${name}; known: ${CASES.map((entry) => entry.name).join(", ")}`);
  return testCase;
};

const EMPTY = caseNamed("empty-result");

const answerTo = async (name: string, sql: string) => {
  const answer = caseNamed(name).answer;
  if (!answer) throw new Error(`case ${name} has no scripted engine`);
  return answer(sql);
};

const open = async (name: string): Promise<EvalRun> => {
  const run = await openCaseRun(caseNamed(name));
  runs.push(run);
  return run;
};

const COUNT_UNNAMED = "SELECT count(*) AS unnamed FROM legal WHERE name IS NULL";
const LIST_UNNAMED = "SELECT id, name FROM legal WHERE name IS NULL";
const COUNT_ALL = "SELECT count(*) AS total FROM legal";

describe("the empty-result case can still fail on the defect it was written for", () => {
  test("a run that reports the zero, citing the count, is unanswered — and the ledger alone cannot say so", async () => {
    // The defect exactly: one read of the missing rows, and the count of them
    // presented as the finding. This is the run #341 saw, in the shape the repaired
    // world lets a model produce.
    const run = await open("empty-result");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_UNNAMED, rationale: "count the unnamed rows" }),
      reportOn("0 people in the legal table have no name recorded."),
    ]);

    // The ledger's own verdict: satisfied. One row came back, so `empty-evidence`
    // has nothing to fire on — which is why the case carries its own bar.
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1", unmet: [] });
    // And the bar, in the exact words the eval's table prints.
    expect(summarise(EMPTY, drive).verdict).toBe("unanswered (zero-as-finding)");
  });

  test("a run that established the population first is scored answered", async () => {
    // The other legible outcome, and the reason the bar is about what the claims
    // RESTED on rather than about the run ever seeing a zero: this run read the same
    // zero, then read the table's own total, and cited both.
    const run = await open("empty-result");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_UNNAMED, rationale: "count the unnamed rows" }),
      callsTool("run_read_query", { sql: COUNT_ALL, rationale: "and how many rows there are at all" }, "call_2"),
      reportOnAll("All five rows in the legal table carry a name, so none is missing one."),
    ]);

    expect(summarise(EMPTY, drive).verdict).toBe("answered");
  });

  test("an empty LISTING alone is caught twice over, by the ledger and by the case", async () => {
    // The shape that survived the repair intact: nothing at all came back, so the
    // goal verifier fires on its own. Asserted so the repair's cost is bounded — it
    // moved one shape out of the ledger's reach, not both.
    const run = await open("empty-result");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: LIST_UNNAMED, rationale: "list the unnamed rows" }),
      reportOn("Nobody in the legal table is missing a name."),
    ]);

    expect(drive.verdict.unmet).toEqual(["empty-evidence"]);
    expect(EMPTY.judge?.(drive)).toBe("zero-as-finding");
    expect(summarise(EMPTY, drive).verdict).toBe("unanswered (empty-evidence)");
  });

  test("a report resting only on the captured inventory is not the table's population", async () => {
    // Zero artifact citations is NOT "no report" — the ledger's verdict has already
    // said this run answered, so what it means here is that every claim rested on the
    // context snapshot. The snapshot says the `legal` table exists and that `name` is
    // nullable; it says nothing about how many rows are in either, which is exactly
    // the fact this case requires the run to have established. The model needs no
    // encouragement to try it: this run composes its report on the FIRST turn, from
    // the only citation the opening prompt offers.
    const run = await open("empty-result");

    const drive = await run.drive([reportCitingWhatWasOffered("No row in the legal table is missing a name.")]);

    expect(drive.modelStatements).toEqual([]);
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1", unmet: [] });
    expect(summarise(EMPTY, drive).verdict).toBe("unanswered (snapshot-not-population)");
  });

  test("a cited statement that never READS the table is not population evidence", async () => {
    // The probe shape a live model actually produced in earlier runs of this very
    // case (#350): `SELECT 1 as x;`, sent while it worked out how to cite what it
    // already had. It mentions no NULL, so a bar that asked only "does this statement
    // avoid the null predicate?" counted it as the table's population and scored the
    // run answered — one probe laundering a report that rests on the zero.
    const run = await open("empty-result");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_UNNAMED, rationale: "count the unnamed rows" }),
      callsTool("run_read_query", { sql: "SELECT 1 AS x", rationale: "check the connection" }, "call_2"),
      reportOnAll("0 people in the legal table have no name recorded."),
    ]);

    expect(summarise(EMPTY, drive).verdict).toBe("unanswered (zero-as-finding)");
  });

  test("a report resting on probes alone is named as that, not as the zero", async () => {
    // Nothing about the target table was read at all, so the run cannot have reported
    // the zero either. Named separately because the eval's table is what a reader
    // sees: `zero-as-finding` about a run that never counted anything would send the
    // next reader looking for a count that does not exist.
    const run = await open("empty-result");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT 1 AS x", rationale: "check the connection" }),
      reportOnAll("Nobody in the legal table is missing a name."),
    ]);

    expect(summarise(EMPTY, drive).verdict).toBe("unanswered (probe-not-population)");
  });

  test("a run that composed nothing is reported as that, not as the case's own shortfall", async () => {
    // The composition rule the workflow verifiers already follow: the baseline
    // dominates. Naming `zero-as-finding` about a run with no report at all would
    // name the smaller of two problems.
    const run = await open("empty-result");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_UNNAMED, rationale: "count them" }),
      answersProse("None of them is missing a name."),
      // The reminder is sent once after a reading; a model that narrates again is
      // stopping rather than hesitating, which is what these scenarios assert.
      answersProse("None of them is missing a name."),
    ]);

    expect(summarise(EMPTY, drive).verdict).toBe("unanswered (no-report)");
  });
});

describe("the scripted world does not contradict itself", () => {
  /**
   * The rule the harness's engines are built to keep: a scripted engine's answers
   * must agree with the inventory the same run handed out, and with each other. A
   * world that disagrees with itself measures the disagreement and nothing else —
   * three cases spent every turn they had establishing that, before the repair.
   */
  test("the complement is answered from the populated world, not from the empty one", async () => {
    // `IS NOT NULL` contains the word `null`, which is what the first repair
    // dispatched on: the complement answered 0 while the total answered 5. A model
    // that checks the complement is the one this case wants to reward.
    const complement = await answerTo("empty-result", "SELECT count(*) AS named FROM legal WHERE name IS NOT NULL");

    expect(complement.rows).toEqual([{ department: "legal", headcount: 5 }]);
  });

  test("the three shapes of the question agree: five rows, five names, none missing", async () => {
    const total = await answerTo("empty-result", COUNT_ALL);
    const listing = await answerTo("empty-result", "SELECT id, name FROM legal");
    const unnamed = await answerTo("empty-result", COUNT_UNNAMED);
    const unnamedRows = await answerTo("empty-result", LIST_UNNAMED);

    expect(total.rows).toEqual([{ department: "legal", headcount: 5 }]);
    expect(listing.rowCount).toBe(5);
    expect(listing.rows.every((row) => typeof row.name === "string" && row.name.length > 0)).toBe(true);
    expect(unnamed.rows).toEqual([{ unnamed: 0 }]);
    expect(unnamedRows.rows).toEqual([]);
  });

  test("a statement mentioning both predicates is still answered as the unnamed question", async () => {
    const both = await answerTo(
      "empty-result",
      "SELECT count(*) FILTER (WHERE name IS NULL) AS unnamed, count(*) FILTER (WHERE name IS NOT NULL) AS named FROM legal",
    );

    expect(both.rows).toEqual([{ unnamed: 0 }]);
  });

  test("a table is what the statement READS, not a word that appears in it", async () => {
    // `people` is one of the eight tables and the empty case's objective contains
    // the word, so word-matching the statement made a single-table question answer
    // with two tables' rows.
    const aliased = await answerTo("one-query-answer", "SELECT count(*) FROM legal AS people");
    const commented = await answerTo("one-query-answer", "-- the people with no name\nSELECT count(*) FROM legal");
    const qualified = await answerTo("one-query-answer", 'SELECT id, name FROM public."legal"');

    expect(aliased.rows).toEqual([{ department: "legal", headcount: 5 }]);
    expect(commented.rows).toEqual([{ department: "legal", headcount: 5 }]);
    expect(qualified.rowCount).toBe(5);
  });

  test("a statement naming no table at all still gets the whole world, so a model is never answered nothing", async () => {
    const everything = await answerTo("one-query-answer", "SELECT count(*) AS headcount");

    expect(everything.rows).toHaveLength(8);
  });
});
