import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  type Turn,
  answersProse,
  callsTool,
  promptText,
  reportCitingWhatWasOffered,
  reportOn,
  reportOnAll,
} from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";
import { ConnectionError, QueryError } from "@/lib/db/errors";

/**
 * The `database-assessment` template, driven end to end on both reference engines
 * (#330 T3).
 *
 * The invariant asserted hardest here is not the arc but the promise the template
 * rests on: **every statement it sends is counts, and no value comes back.** That
 * is what makes profiling a table of personal data acceptable, so it is checked
 * against the statements the run actually sent rather than against the tool's
 * intent.
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

/** A profile answer: one row of aggregates for the eight-column sample table. */
const profileRow = (): Record<string, unknown> => ({
  row_count: 1000,
  present_0: 1000,
  distinct_0: 1000,
  present_1: 400,
  distinct_1: 380,
  shaped_1: 380,
});

async function open(engine: EvalEngine): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    workflowType: "database-assessment",
    objective: "Where is this database's data incomplete or surprising?",
    answer: async (sql) => {
      if (!sql.includes("count(")) return { rows: [{ x: 1 }], fields: ["x"], rowCount: 1, executionTime: 2 };
      const row = profileRow();
      return { rows: [row], fields: Object.keys(row), rowCount: 1, executionTime: 6 };
    },
  });
  runs.push(run);
  return run;
}

const profiles = (table: string, depth?: string) =>
  callsTool("profile_table", depth === undefined ? { table } : { table, depth }, `call_profile_${table}`);

const assessmentArc = (table: string) => [
  profiles(table, "pattern"),
  reportOn("The engineering table has a sparsely populated column and one that looks like contact detail."),
];

describe("the assessment arc, on both reference engines", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: profiles a table, records findings, and answers`, async () => {
      const run = await open(engine);

      const drive = await run.drive(assessmentArc("engineering"));

      // The profile settles a STEP like every other database reach: its invocation
      // is on the ledger before its effect, and its outcome after. Routing it around
      // `runStep` cost the run its cancellation checkpoint and its duplicate
      // protection — found by review on #345.
      expect(drive.kinds).toEqual([
        "run-started",
        "context-captured",
        "tool-invoked",
        "table-profiled",
        "tool-completed",
        "report-composed",
        "run-finished",
      ]);
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-database-assessment.1", unmet: [] });
    });

    test(`${engine}: every statement the profile sent is counts, and no value came back`, async () => {
      const run = await open(engine);

      const drive = await run.drive(assessmentArc("engineering"));

      const profileStatements = drive.modelStatements.filter((sql) => sql.includes("count("));
      expect(profileStatements).toHaveLength(1);
      const projection = profileStatements[0]?.slice("SELECT ".length, profileStatements[0].indexOf(" FROM ")) ?? "";
      for (const part of projection.split(", ")) expect(part.startsWith("count("), part).toBe(true);
      expect(projection).not.toContain("min(");
      expect(projection).not.toContain("max(");
    });

    test(`${engine}: the findings on the ledger are the server's, derived from counts`, async () => {
      const run = await open(engine);

      const drive = await run.drive(assessmentArc("engineering"));

      const profiled = drive.events.find((event) => event.kind === "table-profiled");
      if (profiled?.kind !== "table-profiled") throw new Error("expected a profile");
      expect(profiled.profile.rowCount).toBe(1000);
      expect(profiled.profile.depth).toBe("pattern");
      // 400 present of 1000 rows is over the high-null threshold.
      expect(profiled.profile.findings.map((finding) => finding.code)).toContain("high_null");
      // And nothing in the record is a value from a column.
      for (const finding of profiled.profile.findings) expect(finding.detail).not.toContain("@");
    });
  }
});

describe("the bar this workflow is judged against is stated to the model", () => {
  /*
    The #350/#356 rule, applied to the one workflow that was still missing it.

    `verifyDatabaseAssessmentGoal` requires a `table-profiled` event: a report resting
    on the schema inventory alone is `no-table-profile` however good its prose. The
    rules said "profile the tables that matter", which reads as advice about WHERE to
    look rather than as the condition the report is judged by — and the `operations`
    rules already show what stating a bar looks like ("your report must cite at least
    one reading you took"), with a comment saying why: a rule the model is never told
    is a rule live runs fail.

    Measured across 25 local models on this workflow: 18 failed it, and five of those
    composed a report having called NO tool at all. They were not refusing to profile;
    nothing had told them a profile was required.

    The rule names the TOOL for a measured reason, which is why this asserts the tool
    name and not a paraphrase. Told "profile at least one table", one model composed
    eighteen count statements by hand with `run_read_query` and three other models went
    to `inspect_schema`: every one of them had done what the sentence asked and none
    produced the `table-profiled` event the verifier reads.
  */
  test("a run is told which tool it must call before it reports", async () => {
    const prompts: string[] = [];
    const run = await open("sqlite");

    await run.drive([
      (turn) => {
        prompts.push(promptText(turn));
        return answersProse("nothing to do")(turn);
      },
    ]);

    expect(prompts[0]).toContain("call profile_table on at least one table before you report");
  });

  test("and a run that reports without one is judged exactly that way", async () => {
    // The other half, so the rule above is stated because it is enforced rather than
    // as decoration. Both directions are asserted for the reason the operations
    // verifier test gives: an arm that only ever fires would fail every accurate run.
    const run = await open("sqlite");

    // Citing the inventory the server captured, which is the shape a live run took:
    // a report about the data resting on the list of table names alone.
    // Twice: the run is asked for a profile once before its report is allowed through, and
    // this one is about what happens when it does not take the offer.
    const drive = await run.drive([
      reportCitingWhatWasOffered("The data looks incomplete in places."),
      reportCitingWhatWasOffered("The data looks incomplete in places."),
      reportCitingWhatWasOffered("The data looks incomplete in places."),
    ]);

    expect(drive.verdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-database-assessment.1",
      unmet: ["no-table-profile"],
    });
  });
});

describe("a profile's artifact is an artifact like any other", () => {
  test("it settles a step, so it is citable, fetchable and charged to the budget", async () => {
    // Three consumers read `tool-completed` and nothing else: `composeReportTool`'s
    // citation check, the artifact route's authorization, and the rail's budget
    // fold. A profile that emitted no settlement would be citable in a report whose
    // "Show result" always answered 404, on a meter reading zero. Settling the step
    // is what makes all three correct at once — found by review on #345.
    const run = await open("postgres");

    const drive = await run.drive(assessmentArc("engineering"));

    const profiled = drive.events.find((event) => event.kind === "table-profiled");
    const settled = drive.events.find((event) => event.kind === "tool-completed");
    if (profiled?.kind !== "table-profiled" || settled?.kind !== "tool-completed") {
      throw new Error("expected both a profile and its settlement");
    }
    expect(settled.artifact.correlationId).toBe(profiled.artifact.correlationId);
    expect(settled.artifact.operationId).toBe("sql.table.profile");
  });

  test("the same profile asked for twice is replayed, not re-read", async () => {
    // The claim an earlier version made and could not keep: the repair ledger
    // records only FAILED statements, so nothing stopped a successful profile from
    // running again. The step's identity does.
    const run = await open("postgres");

    const drive = await run.drive([
      profiles("engineering", "pattern"),
      profiles("engineering", "pattern"),
      reportOn("The engineering table has a sparse column."),
    ]);

    expect(drive.modelStatements.filter((sql) => sql.includes("count("))).toHaveLength(1);
    expect(drive.kinds.filter((kind) => kind === "table-profiled")).toHaveLength(1);
    expect(drive.transcripts[2]).toContain("That exact profile was already taken in this run");
  });
});

describe("a profile can only be aimed at a table the run has inventoried", () => {
  test("a table the schema capture never returned is refused before any database reach", async () => {
    const run = await open("postgres");

    const drive = await run.drive([
      profiles("secrets"),
      answersProse("I could not profile that."),
      answersProse("I could not profile that."),
    ]);

    expect(drive.modelStatements).toEqual([]);
    expect(drive.transcripts[1]).toContain("not in the schema inventory");
    expect(drive.kinds).not.toContain("table-profiled");
  });
});

describe("THE GATE: the verifier fails the run when the template's own artifact is absent", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: a cited report written from the schema alone does not assess the data`, async () => {
      const run = await open(engine);

      /*
        Two report turns, because the run is now told what its report is missing BEFORE
        that report lands (`shortfallsIfReported`): held back once and asked for a
        profile. The second report is the model declining, which is what this gate is
        about — the bar closes on a run that will not profile, and the nudge does not
        rescue it.
      */
      const drive = await run.drive([
        callsTool("run_read_query", { sql: "SELECT 1", rationale: "a look" }),
        reportOn("The schema has eight tables and looks reasonable."),
        reportOn("The schema has eight tables and looks reasonable."),
        reportOn("The schema has eight tables and looks reasonable."),
      ]);

      expect(drive.status).toBe("succeeded");
      expect(drive.stopReason).toBe("report-composed");
      expect(drive.verdict).toEqual({
        outcome: "unanswered",
        verifier: "agent-database-assessment.1",
        unmet: ["no-table-profile"],
      });
    });
  }
});

describe("the tool belongs to the workflow", () => {
  test("an investigation asking to profile a table is told there is no such tool", async () => {
    const run = await openEvalRun({ objective: "What is in here?" });
    runs.push(run);

    const drive = await run.drive([
      (turn: Turn) => {
        void turn;
        return chatToolCallStream("profile_table", JSON.stringify({ table: "engineering" }), "call_profile");
      },
      answersProse("I cannot profile from here."),
      // The reminder is sent once after a reading; a model that narrates again is
      // stopping rather than hesitating, which is what these scenarios assert.
      answersProse("I cannot profile from here."),
    ]);

    expect(drive.transcripts[1]).toContain("There is no tool called");
    expect(drive.modelStatements).toEqual([]);
  });
});

describe("a drive that dies after profiling does not profile again", () => {
  test("the resumed run is told what it already profiled", async () => {
    const run = await open("postgres");

    await expect(run.drive([profiles("engineering", "pattern")])).rejects.toThrow(/died before turn/);

    const resumed = await run.drive([reportOn("The engineering table has a sparse column.")]);

    expect(resumed.transcripts[0] ?? "").toContain("was already profiled");
    expect(resumed.statements).toEqual([]);
    expect(resumed.verdict.outcome).toBe("answered");
  });
});

describe("a profile that does not settle cleanly", () => {
  test("a statement that fails at the database is refused, and the run may go on", async () => {
    const run = await openEvalRun({
      engine: "postgres",
      workflowType: "database-assessment",
      objective: "Where is this database's data incomplete?",
      answer: async (sql) => {
        if (sql.includes("count(")) throw new QueryError('relation "engineering" does not exist');
        return { rows: [{ x: 1 }], fields: ["x"], rowCount: 1, executionTime: 2 };
      },
    });
    runs.push(run);

    const drive = await run.drive([
      profiles("engineering"),
      answersProse("That table is gone."),
      answersProse("That table is gone."),
    ]);

    expect(drive.kinds).toContain("tool-refused");
    expect(drive.kinds).not.toContain("table-profiled");
    // The engine's own words, fenced.
    expect(drive.transcripts[1]).toContain("BEGIN UNTRUSTED DATABASE CONTENT");
  });

  test("a result that does not read back as counts settles nothing, and asking again is told nothing ran", async () => {
    // The step settles nothing, so by ledger shape alone it is indistinguishable
    // from a mid-flight death. It is not the same thing to a model — nothing was
    // recorded, but the read DID happen — so asking again must be told that this
    // exact call will not be sent again, not that its outcome is unknowable.
    const run = await openEvalRun({
      engine: "postgres",
      workflowType: "database-assessment",
      objective: "Where is this database's data incomplete?",
      // Counts came back under names the profile cannot read.
      answer: async () => ({ rows: [{ total: 5 }], fields: ["total"], rowCount: 1, executionTime: 3 }),
    });
    runs.push(run);

    const drive = await run.drive([
      profiles("engineering"),
      profiles("engineering"),
      answersProse("I cannot read it."),
      // The reminder is sent once after a reading; a model that narrates again is
      // stopping rather than hesitating, which is what these scenarios assert.
      answersProse("I cannot read it."),
    ]);

    expect(drive.kinds).not.toContain("table-profiled");
    expect(drive.transcripts[1]).toContain("could not be read as counts");
    expect(drive.transcripts[2]).toContain("refused before the database was reached");
  });

  test("a profile interrupted before its outcome was recorded is never repeated", async () => {
    // The process-death window: the invocation is durable, the outcome is not, and
    // whether the read reached the database is unknowable. Re-running it would be
    // the duplicate execution the write-ahead ordering exists to prevent.
    let reaches = 0;
    const run = await openEvalRun({
      engine: "postgres",
      workflowType: "database-assessment",
      objective: "Where is this database's data incomplete?",
      // The three catalog reads succeed; the profile's acquisition does not.
      acquireFails: () => (++reaches > 3 ? new ConnectionError("the pool went away") : undefined),
    });
    runs.push(run);

    await expect(run.drive([profiles("engineering")])).rejects.toThrow(/pool went away/);
    expect((await run.events()).map((event) => event.kind)).toEqual([
      "run-started",
      "context-captured",
      "tool-invoked",
    ]);

    const resumed = await run.drive([
      profiles("engineering"),
      answersProse("I cannot know."),
      answersProse("I cannot know."),
    ]);

    expect(resumed.transcripts[1]).toContain("outcome was never recorded");
    expect(resumed.kinds).not.toContain("table-profiled");
  });
});

describe("the verdict is previewed before the report lands, not after the run dies", () => {
  /*
    The architectural form of every notice in this loop, and the reason it exists.

    Seven separate fixes were measured today and all seven were the same mistake wearing
    different names: the model did the work and then missed a protocol detail on its
    finishing move — wrote the report as prose, wrote SQL without a fence, cited the
    inventory instead of its readings, took one plan instead of two, analysed with
    `run_read_query` instead of `profile_table`. Each cost the run everything it had done,
    because the finishing move gets exactly one attempt.

    Five of those were answered by hand-written notices, one per shortfall. That does not
    scale and it drifts: a bar this repository stated in its own words for `database-assessment`
    was phrased as an activity rather than a tool, and four models satisfied the sentence
    while failing the check.

    So the notice is DERIVED from the verifier instead. `VerifiableAgentRun` is a Pick over
    the record, so the loop can assemble the run it is about to become — the ledger so far
    plus the report being submitted — hand it to `verifyRunGoal`, and read the shortfalls
    that report WOULD earn. What the model is told is then the verifier's own vocabulary,
    which cannot fall out of step with the check the way a duplicated sentence can.

    `no-table-profile` is the largest shortfall not already covered by a hand-written
    notice: 8 of 25 models on this surface, four of them having called no tool at all.
  */
  test("an assessment reporting without a profile is held back and told which tool to call", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT count(*) FROM engineering", rationale: "counting by hand" }),
      reportOnAll("The engineering table looks sparsely populated."),
      profiles("engineering", "basic"),
      reportOnAll("The engineering table has a sparsely populated column."),
    ]);

    // Held back once, and told the tool by name — the wording that was measured to matter.
    expect(drive.transcripts[2]).toContain("profile_table");
    // And the run went on to clear its own bar.
    expect(drive.kinds).toContain("table-profiled");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-database-assessment.1", unmet: [] });
  });

  test("and it is narrowed to what would fix it, so it cannot spend the turn elsewhere", async () => {
    /*
      Measured with the ledger's own record of the hold, once `call-held` made holds
      visible. On that model the notice fired and it then called `inspect_schema`
      four times and `run_read_query` three times without ever profiling; on `qwen3:8b` it
      fired and the run went back to `inspect_schema`. `qwen3.5:9b` took the offer on one
      run and answered.

      So the notice is heard and the wandering is what beats it — which is what the
      narrowing mechanism already exists for. A held call narrows the run to the tools its
      own verdict accepts, and on this workflow that is exactly `profile_table` and
      `compose_report`: it can fix the thing it was asked to fix, or say nothing.
    */
    const named: string[][] = [];
    const run = await open("sqlite");

    await run.drive([
      callsTool("run_read_query", { sql: "SELECT count(*) FROM engineering", rationale: "by hand" }),
      reportOnAll("The engineering table looks sparsely populated."),
      (turn) => {
        named.push(
          ((turn.body.tools ?? []) as { function?: { name?: string } }[]).map((entry) => entry.function?.name ?? ""),
        );
        return answersProse("nothing further")(turn);
      },
      // One more, because narrating instead of acting earns the report reminder and the
      // drive takes another turn for it.
      answersProse("still nothing further"),
    ]);

    expect(named[0]?.sort()).toEqual(["compose_report", "profile_table"]);
  });

  test("a run that ignores it still reports, and still fails the bar honestly", async () => {
    // The guarantee every notice here keeps: offered once, then out of the way. Trading
    // `no-table-profile` for `no-report` would be the worse outcome, not a smaller one.
    const run = await open("sqlite");

    // Three reports: the run is held twice — a model that ignored the first ask gets a
    // second — and the third is let through so the gate can close on it.
    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT count(*) FROM engineering", rationale: "counting by hand" }),
      reportOnAll("The engineering table looks sparsely populated."),
      reportOnAll("The engineering table looks sparsely populated."),
      reportOnAll("The engineering table looks sparsely populated."),
    ]);

    expect(drive.stopReason).toBe("report-composed");
    expect(drive.verdict.unmet).toEqual(["no-table-profile"]);
  });

  test("every turn is sampled deterministically, because the bar is consistency", async () => {
    /*
      The agent loop never set a sampling temperature, so every run so far inherited Ollama's
      defaults: temperature 0.8, top_p 0.9.

      That is the wrong setting for what this harness measures. A cell counts as working only
      at 5/5 consecutive passes, which makes it a variance test as much as a capability one,
      and 26 of the cells that do not lock sit at 4/5 — one run away. A twelve-step tool chain
      sampled at 0.8 is a large avoidable source of exactly the flapping that keeps them
      there. Choosing a tool and filling its arguments is a structural task, not a creative
      one: there is no upside to sampling it.

      Asserted on the request body rather than on an outcome, because that is where it either
      is or is not — a default this loop never states is a default nobody notices.
    */
    const seen: unknown[] = [];
    const run = await open("sqlite");

    await run.drive([
      (turn) => {
        seen.push({ temperature: turn.body.temperature, topP: turn.body.top_p });
        return answersProse("looking at the schema")(turn);
      },
      answersProse("still looking"),
    ]);

    expect(seen[0]).toEqual({ temperature: 0, topP: 1 });
  });

  test("a report that already meets its bar is not delayed by a turn", async () => {
    const run = await open("sqlite");

    const drive = await run.drive(assessmentArc("engineering"));

    expect(drive.kinds).toEqual([
      "run-started",
      "context-captured",
      "tool-invoked",
      "table-profiled",
      "tool-completed",
      "report-composed",
      "run-finished",
    ]);
  });
});

describe("a run that reports past the notice is asked again, up to a bound", () => {
  /*
    Measured at five repeats on three models, and the shape is identical every time:

      inspect_schema, inspect_schema
      call-held            <- the notice fires and the run is narrowed to {profile_table, compose_report}
      report-composed      <- and the model reports anyway
      no-table-profile

    `qwen3:8b`, `qwen3:14b` and a third model lose this surface 5 times out of 5, so it is not
    variance: told once, left holding only the two tools its verdict accepts, the model picks
    the report again. One ask was a guess, and fifteen consecutive losses are the answer to it.

    BOUNDED at three, and the bound is what separates this from the change reverted earlier
    today. That one repeated the ask on SILENCE, which every run passes through, and eighteen
    tests failed because every run took two more turns. This fires only where a report is being
    submitted that its own verdict would reject — a run already losing — so a run that is about
    to pass cannot reach it. What an uncooperative model costs is two extra turns before the
    same verdict it was going to get.
  */
  test("a second report without a profile is held too", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT count(*) FROM engineering", rationale: "by hand" }),
      reportOnAll("The engineering table looks sparsely populated."),
      reportOnAll("The engineering table looks sparsely populated."),
      profiles("engineering", "basic"),
      reportOnAll("The engineering table has a sparsely populated column."),
    ]);

    // Held twice, and the run still ended by clearing its own bar.
    expect(drive.events.filter((event) => event.kind === "call-held")).toHaveLength(2);
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-database-assessment.1", unmet: [] });
  });

  test("and it asks for the table the report is actually about", async () => {
    /*
      The bug the repeated ask uncovered, and the reason repeating it alone changed nothing.

      `qwen3:8b` was measured again after the second ask shipped: still 0/5, and now the
      ledger showed the notice firing TWICE and being ignored twice. What it was asking for
      was the problem. The notice named `inventory[0]` — the first table in the snapshot —
      and on the sample database that is `current_dept_emp`, a VIEW the catalog read
      describes with no columns at all. Meanwhile the model's pending report was about
      `dept_emp`: 450,000 rows, five percent of its `dept_no` values referencing no
      department. We were telling it to go profile something it had no interest in, and it
      declined, which is not unreasonable of it.

      So the notice asks about the table the report is ALREADY making claims about. That is
      both likelier to be obeyed and more correct: what this verdict wants established is the
      claims being made, not an arbitrary table.

      This fixture's first table is `engineering`, which every other test here also reports
      on — which is exactly why the evals never caught it. Reporting on a later table is what
      makes the two candidates different.
    */
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT count(*) FROM research", rationale: "by hand" }),
      reportOnAll("The research table is missing most of its second column."),
      profiles("research", "basic"),
      reportOnAll("The research table has a sparsely populated column."),
    ]);

    const held = drive.events.filter((event) => event.kind === "call-held");
    expect(held[0]?.reason).toContain('"research"');
    expect(held[0]?.reason).not.toContain("engineering");
  });

  test("the asking stops, so a model that will not profile still gets its honest verdict", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: "SELECT count(*) FROM engineering", rationale: "by hand" }),
      ...Array.from({ length: 5 }, () => reportOnAll("The engineering table looks sparsely populated.")),
    ]);

    expect(drive.stopReason).toBe("report-composed");
    expect(drive.verdict.unmet).toEqual(["no-table-profile"]);
    // Three asks and no more: the bound is what keeps an uncooperative run from spending its
    // budget on being asked.
    expect(drive.events.filter((event) => event.kind === "call-held").length).toBeLessThanOrEqual(3);
  });
});
