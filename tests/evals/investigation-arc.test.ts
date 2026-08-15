import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { DEPARTMENTS, type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { answersProse, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";
import { CASES, openCaseRun, summarise } from "./real-model";

/**
 * The canonical investigation, on both Phase 1 engines (#330 T1).
 *
 * Expressed as ledgers rather than as prose expectations, for the reason #341
 * records: the one existing test that touched "did the run answer" asserted the
 * model's text was returned to the CALLER, which is a correct test of the wrong
 * thing. A user reads the ledger, a resumed process reads the ledger, and so does
 * the goal verifier.
 *
 * The engines are asserted separately rather than parameterised into one shape,
 * because their catalog behaviour genuinely differs and a shared assertion would
 * hide it: PostgreSQL reads three inventories, SQLite reads two.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  // The audited execution layer writes one JSON line per operation to stdout.
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  // What a plan run may be handed outlives the run that read it (#384), so each
  // scenario states its own starting point instead of inheriting the last one's.
  forgetHeldSnapshots();
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

async function open(engine: EvalEngine, options: Parameters<typeof openEvalRun>[0] = {}): Promise<EvalRun> {
  const run = await openEvalRun({ engine, ...options });
  runs.push(run);
  return run;
}

const COUNT_BY_DEPARTMENT =
  "SELECT department, count(*) AS headcount FROM employees GROUP BY department ORDER BY 2 DESC";

describe("an investigation that answers, on both reference engines", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: reads, reports with evidence, and is recorded as answered`, async () => {
      const run = await open(engine);

      const drive = await run.drive([
        callsTool("run_read_query", { sql: COUNT_BY_DEPARTMENT, rationale: "one query answers the whole question" }),
        reportOn("Engineering has the most employees, at 41."),
      ]);

      expect(drive.kinds).toEqual([
        "run-started",
        "context-captured",
        "statement-drafted",
        "tool-invoked",
        "tool-completed",
        "report-composed",
        "run-finished",
      ]);
      expect(drive.status).toBe("succeeded");
      expect(drive.stopReason).toBe("report-composed");
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1", unmet: [] });
    });

    test(`${engine}: the model's question is answered with one statement, not one per table`, async () => {
      const run = await open(engine);

      const drive = await run.drive([
        callsTool("run_read_query", { sql: COUNT_BY_DEPARTMENT, rationale: "one query answers the whole question" }),
        reportOn(),
      ]);

      expect(drive.modelStatements).toEqual([COUNT_BY_DEPARTMENT]);
    });
  }

  test("postgres reads three catalog inventories before the first turn", async () => {
    const run = await open("postgres");

    const drive = await run.drive([answersProse("Nothing to add.")]);

    expect(drive.statements).toHaveLength(3);
    expect(drive.modelStatements).toEqual([]);
  });

  test("sqlite reads two, because its object read carries the relations in the DDL", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([answersProse("Nothing to add.")]);

    expect(drive.statements).toHaveLength(2);
    expect(drive.modelStatements).toEqual([]);
  });
});

describe("a planning run is judged by what planning mode can produce", () => {
  test("a plan in prose reaches the ledger and counts as answered", async () => {
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse("First I would ", "read the employees table.")]);

    // #341 F1: planning was mute by construction until `closing-statement` existed.
    expect(drive.kinds).toEqual(["run-started", "closing-statement", "run-finished"]);
    expect(drive.statements).toEqual([]);
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("a planning run that says nothing is recorded as unanswered", async () => {
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse("")]);

    expect(drive.kinds).toEqual(["run-started", "run-finished"]);
    expect(drive.verdict.unmet).toEqual(["no-plan"]);
  });

  /*
    The scenario #384 exists for, end to end: an agent run reads this connection's
    catalog through the audited path, and the plan run that follows is given what it
    read — every table by name, and not one statement of its own.

    Both runs are opened before either is driven, which is what makes the ORDER the
    thing under test: the plan run is grounded by the reading, not by having been
    opened after it.
  */
  test("a plan run on a connection this deployment has already read plans against its real tables", async () => {
    const reader = await open("postgres");
    const planner = await open("postgres", { mode: "planning" });

    const reading = await reader.drive([answersProse("Nothing to add.")]);
    const drive = await planner.drive([answersProse("I would start with ", "the employees table.")]);

    expect(reading.statements).toHaveLength(3);
    // The plan run sent none of its own, and recorded no capture: what it was given,
    // it was given for free.
    expect(drive.statements).toEqual([]);
    expect(drive.kinds).toEqual(["run-started", "closing-statement", "run-finished"]);
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });

    const transcript = drive.transcripts[0] ?? "";
    for (const table of DEPARTMENTS) expect(transcript).toContain(table);
    expect(transcript).toContain("This run has read nothing and will read nothing.");
  });

  test("a plan run on a connection nothing has read says so instead of inventing tables", async () => {
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse("I would begin with the catalog.")]);

    expect(drive.statements).toEqual([]);
    expect(drive.transcripts[0] ?? "").toContain("No schema inventory is available to this run");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });
});

/*
  What the real-model eval's `planning-grounded` case can catch, pinned the way
  `empty-result-detection.test.ts` pins its own case: with the case object the live
  job uses, and a scripted model where the live one goes.

  The case is the only measurement of whether a REAL model uses an inventory it was
  handed, so what it can detect must not be established by reading it. Two things
  are asserted — that opening the case grounds its run at all, and that its bar
  separates a plan naming a real table from one naming none.
*/
describe("the planning-grounded case can fail on the defect it was written for", () => {
  const planningCase = CASES.find((entry) => entry.name === "planning-grounded");
  if (!planningCase) throw new Error("no eval case named planning-grounded");

  const openCase = async (): Promise<EvalRun> => {
    const run = await openCaseRun(planningCase);
    runs.push(run);
    return run;
  };

  test("opening the case grounds its run, without the case sending anything itself", async () => {
    const run = await openCase();

    const drive = await run.drive([answersProse("I would start with the engineering table.")]);

    // The warm-up read the catalog; the case's own run read nothing.
    expect(drive.statements).toEqual([]);
    expect(drive.transcripts[0] ?? "").toContain("This run has read nothing and will read nothing.");
  });

  test("a plan naming no real table is scored unanswered, and one naming a real table is not", async () => {
    const naming = await openCase();
    const named = await naming.drive([answersProse("I would profile ", "the engineering table first.")]);
    expect(summarise(planningCase, named).verdict).toBe("answered");

    const vague = await openCase();
    const generic = await vague.drive([answersProse("I would review schema definitions and available artifacts.")]);
    expect(summarise(planningCase, generic).verdict).toBe("unanswered (plan-names-no-real-table)");
  });

  /*
    Prose is not an identifier. A model writing "the Engineering table", or quoting
    the name as SQL uppercases it, has named the table this bar is about — and a
    judge that missed it would report the defect against a run that did exactly what
    it was supposed to, which is worse than having no bar.
  */
  test("the bar reads a table name the way a sentence writes it, not the way the catalog stores it", async () => {
    const run = await openCase();

    const drive = await run.drive([
      answersProse("I would start with the Engineering table, then ENGINEERING's indexes."),
    ]);

    expect(summarise(planningCase, drive).verdict).toBe("answered");
  });
});

describe("the verdict is on the ledger, where a user reads it (B24)", () => {
  test("a run that answered records its verdict beside its status, not instead of it", async () => {
    const run = await open("postgres");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_BY_DEPARTMENT, rationale: "one query" }),
      reportOn("Engineering has the most employees."),
    ]);

    const finished = drive.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.status).toBe("succeeded");
    expect(finished.goalVerdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1" });
    // `unmet` is omitted when the run answered, so the two halves cannot disagree.
    expect(finished.goalVerdict?.unmet).toBeUndefined();
  });

  test("a run that stopped without reporting says so on the ledger, while its status stays succeeded", async () => {
    // The #341 shape: the status word alone has been observed saying the wrong thing.
    const run = await open("postgres");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_BY_DEPARTMENT, rationale: "one query" }),
      answersProse("Engineering has the most employees."),
    ]);

    const finished = drive.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.status).toBe("succeeded");
    expect(finished.goalVerdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-investigation.1",
      unmet: ["no-report"],
    });
  });

  test("a cancelled run records the cancellation as its shortfall, not a missing report", async () => {
    const run = await open("postgres");
    const stopsThenAsks = async (): Promise<Response> => {
      await run.requestCancellation();
      return chatToolCallStream("run_read_query", JSON.stringify({ sql: COUNT_BY_DEPARTMENT }), "call_1");
    };

    const drive = await run.drive([stopsThenAsks]);

    const finished = drive.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.status).toBe("cancelled");
    expect(finished.goalVerdict?.unmet).toEqual(["cancelled"]);
  });
});

describe("the schema's relations reach the model as their own fenced block", () => {
  test("a run is shown the relation graph beside the inventory", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([answersProse("Noted.")]);

    const transcript = drive.transcripts[0] ?? "";
    expect(transcript).toContain("schema relations");
    // The sample declares no foreign keys, and the block says so rather than
    // showing an empty list a reader could mistake for "the run did not look".
    expect(transcript).toContain("no table in this inventory declares a foreign key");
  });

  test("the block is fenced, so identifiers in it are untrusted content like any other", async () => {
    const run = await open("postgres");

    const drive = await run.drive([answersProse("Noted.")]);

    const transcript = drive.transcripts[0] ?? "";
    const opened = transcript.indexOf("schema relations");
    expect(opened).toBeGreaterThan(-1);
    expect(transcript.slice(opened)).toContain("BEGIN UNTRUSTED DATABASE CONTENT");
  });
});
