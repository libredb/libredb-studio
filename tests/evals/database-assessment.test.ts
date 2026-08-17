import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { type Turn, answersProse, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";
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

      const drive = await run.drive([
        callsTool("run_read_query", { sql: "SELECT 1", rationale: "a look" }),
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
