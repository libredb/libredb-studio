import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { answersProse, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";

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
});
