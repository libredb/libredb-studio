import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  type Turn,
  answersProse,
  callsTool,
  modelOver,
  reportOn,
  scriptedModel,
} from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";

/**
 * A drive that dies, a statement that is repaired, and a stop that is observed
 * (#330 T1).
 *
 * These properties are pinned in depth by `tests/isolated/agent-investigation.test.ts`,
 * which is where they belong: they are properties of the run loop. What they are
 * doing HERE is different and narrower — a scenario suite that could not express a
 * crash, a repair or a cancellation would be a harness that only measures the happy
 * path, and every real run this milestone has to grade will contain at least one of
 * the three. Each is therefore asserted once, as a ledger, in the idiom the template
 * scenarios of T3 will be written in.
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

async function open(options: Parameters<typeof openEvalRun>[0] = {}): Promise<EvalRun> {
  const run = await openEvalRun(options);
  runs.push(run);
  return run;
}

const FIRST = "SELECT department, count(*) FROM employees GROUP BY department";
const SECOND = "SELECT department, count(*) FROM staff GROUP BY department";

describe("a drive that dies mid-run leaves a run another process can finish", () => {
  test("the resumed drive replays the settled step instead of executing it again", async () => {
    const run = await open();

    // The script runs out after one turn, which IS the process death: the driving
    // process stops answering, exactly as it would if it had been killed.
    await expect(run.drive([callsTool("run_read_query", { sql: FIRST, rationale: "count" })])).rejects.toThrow(
      /died before turn/,
    );

    const afterCrash = (await run.events()).map((event) => event.kind);
    expect(afterCrash).toEqual([
      "run-started",
      "context-captured",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
    ]);

    // A genuinely second set of in-memory objects over the same directory: nothing
    // is carried across but the ledger.
    const resumed = await run.drive([
      callsTool("run_read_query", { sql: FIRST, rationale: "count again" }),
      reportOn(),
    ]);

    expect(resumed.status).toBe("succeeded");
    expect(resumed.verdict.outcome).toBe("answered");
    // The resumed drive reached the database for NOTHING: not for the settled step,
    // and not for a catalog it already had in its ledger.
    expect(resumed.statements).toEqual([]);
  });

  test("a resumed run is told what it established, without being handed the rows again", async () => {
    const run = await open();

    await expect(run.drive([callsTool("run_read_query", { sql: FIRST, rationale: "count" })])).rejects.toThrow();
    const resumed = await run.drive([reportOn()]);

    const firstTurn = resumed.transcripts[0] ?? "";
    expect(firstTurn).toContain("This run was interrupted and has been resumed");
    expect(firstTurn).toContain("The rows themselves are not delivered again");
  });
});

describe("a failed statement is told what the table actually holds", () => {
  /*
    The largest refusal in the system, answered. Of 368 `database-error` refusals on record, some
    eighty are one shape — a column that is not there:

        no such column: salary.dept_no
        no such column: employee.dept_no
        no such column: d.dept_name

    The engine says which name failed. It never says which names would have worked, and this
    process is holding exactly that: the inventory captured for this connection at the top of the
    run. Naming it is the same move that was worth nineteen cells at the tool layer today, on the
    busiest path there is.

    Driven rather than unit-tested, and that is forced rather than chosen:
    `holdSnapshotForConnection` verifies a snapshot's fingerprint before keeping it, so no test
    can hold a fabricated inventory. Only a real capture will do, which is what a drive does.
  */
  test("the columns that exist are named, from the run's own captured inventory", async () => {
    const run = await open({
      answer: async () => {
        throw new QueryError("no such column: engineering.dept_no");
      },
    });
    // Three turns: the read that fails, the report the run makes anyway, and one more for the
    // drive to conclude on. A refused statement opens a repair turn, so the arc is longer than
    // the two calls the scenario is about.
    const scripted = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT dept_no FROM engineering", rationale: "count" }),
      // Prose rather than a report: the read failed, so this run holds no artifact to cite and
      // `reportOn` has nothing to build a citation from. What the test is about is the sentence
      // the refusal sent back, which is already in the transcript by then.
      answersProse("I could not read that."),
      answersProse("done"),
    );

    // A model whose ledger earned the advice; every other model gets the engine's words alone.
    await run.driveModel(await modelOver(scripted.fetch, "https://api.openai.com/v1", "granite4.1:8b"));

    // The fixture's tables carry `id` and `name`, and neither came from the error text: the
    // qualifier was pulled out of it and used only to find the table in our own snapshot.
    const told = scripted.turns.at(-1)?.transcript ?? "";
    expect(told).toContain("has no dept_no");
    expect(told).toContain("id");
    expect(told).toContain("name");
  });

  test("and where that column actually lives, when the inventory has it elsewhere", async () => {
    /*
      Naming what a table holds does not answer a model looking for a join key. Measured:
      One evaluated model asked for `department.emp_no` twice in one run, having been told after the first
      that department holds dept_no and dept_name. It was not confused about department — it was
      looking for where emp_no lives, and that is in the inventory too.

      The fixture's tables all carry `name`, so a column missing from one is present in the
      others, which is the shape this asserts.
    */
    const run = await open({
      answer: async () => {
        throw new QueryError("no such column: engineering.name_x");
      },
    });
    const scripted = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT name_x FROM engineering", rationale: "count" }),
      answersProse("I could not read that."),
      answersProse("done"),
    );

    await run.driveModel(await modelOver(scripted.fetch, "https://api.openai.com/v1", "granite4.1:8b"));

    const told = scripted.turns.at(-1)?.transcript ?? "";
    expect(told).toContain("has no name_x");
    // No other table holds it either, so nothing is claimed about where it lives.
    expect(told).not.toContain("join through");
  });

  test("the tables that do hold it are named, so a join key can be found", async () => {
    // Every fixture table carries `name`, so a run told that one lacks it should be pointed at
    // the others. This is the arm that model needed and did not get: it asked twice for a column
    // that exists, in a different table, and was twice told only what the first one holds.
    const run = await open({
      answer: async () => {
        throw new QueryError("no such column: engineering.name");
      },
    });
    const scripted = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT name FROM engineering", rationale: "count" }),
      answersProse("I could not read that."),
      answersProse("done"),
    );

    await run.driveModel(await modelOver(scripted.fetch, "https://api.openai.com/v1", "granite4.1:8b"));

    const told = scripted.turns.at(-1)?.transcript ?? "";
    expect(told).toContain("join through");
    expect(told).toContain("sales");
  });

  test("an alias in front of the table does not hide it", async () => {
    /*
      Measured, and it is why this case exists. Across a whole sweep of the three models that
      carry the advice, exactly ONE database error could have been answered by it — and it read
      `no such column: e.dept_emp.dept_no`: alias, table, column. The first version of the reader
      took the first two segments, looked up "e", found nothing, and said nothing.

      The last two are the table and the column. The alias in front is the statement's, not the
      schema's.
    */
    const run = await open({
      answer: async () => {
        throw new QueryError("no such column: e.engineering.dept_no");
      },
    });
    const scripted = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT e.dept_no FROM engineering e", rationale: "count" }),
      answersProse("I could not read that."),
      answersProse("done"),
    );

    await run.driveModel(await modelOver(scripted.fetch, "https://api.openai.com/v1", "granite4.1:8b"));

    const told = scripted.turns.at(-1)?.transcript ?? "";
    expect(told).toContain("has no dept_no");
    expect(told).toContain("name");
  });

  test("a model that has not earned it gets the engine's words and nothing more", async () => {
    // The rule every behaviour added today obeys: off by default, on where a ledger earned it.
    const run = await open({
      answer: async () => {
        throw new QueryError("no such column: engineering.dept_no");
      },
    });
    const scripted = scriptedModel(
      callsTool("run_read_query", { sql: "SELECT dept_no FROM engineering", rationale: "count" }),
      // Prose rather than a report: the read failed, so this run holds no artifact to cite and
      // `reportOn` has nothing to build a citation from. What the test is about is the sentence
      // the refusal sent back, which is already in the transcript by then.
      answersProse("I could not read that."),
      answersProse("done"),
    );

    await run.driveModel(await modelOver(scripted.fetch));

    const told = scripted.turns.at(-1)?.transcript ?? "";
    expect(told).toContain("no such column");
    expect(told).not.toContain("has no dept_no");
  });
});

describe("a statement that fails at the database is repaired, not repeated", () => {
  test("the failure and its replacement both reach the ledger, and the run still answers", async () => {
    const run = await open({
      answer: async (sql) => {
        if (sql === FIRST) throw new QueryError('relation "employees" does not exist');
        return { rows: [{ department: "engineering" }], fields: ["department"], rowCount: 1, executionTime: 5 };
      },
    });

    const drive = await run.drive([
      callsTool("run_read_query", { sql: FIRST, rationale: "count" }),
      callsTool("run_read_query", { sql: SECOND, rationale: "the table is called staff" }, "call_2"),
      reportOn("Engineering is the largest department."),
    ]);

    expect(drive.kinds).toEqual([
      "run-started",
      "context-captured",
      "statement-drafted",
      "tool-invoked",
      "tool-refused",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      "report-composed",
      "run-finished",
    ]);
    expect(drive.verdict.outcome).toBe("answered");
  });

  test("the engine's own words reach the model fenced as untrusted content", async () => {
    const run = await open({
      answer: async (sql) => {
        if (sql === FIRST) throw new QueryError('relation "employees" does not exist');
        return { rows: [{ department: "engineering" }], fields: ["department"], rowCount: 1, executionTime: 5 };
      },
    });

    const drive = await run.drive([
      callsTool("run_read_query", { sql: FIRST, rationale: "count" }),
      callsTool("run_read_query", { sql: SECOND, rationale: "the table is called staff" }, "call_2"),
      reportOn(),
    ]);

    // Second turn: what the model was told about the failure.
    expect(drive.transcripts[1]).toContain("BEGIN UNTRUSTED DATABASE CONTENT");
  });
});

describe("a cancellation is observed and ends the run", () => {
  test("a stop recorded while the model was thinking ends the run before its statement runs", async () => {
    const run = await open();

    const stopsThenAsks = async (_turn: Turn): Promise<Response> => {
      await run.requestCancellation();
      return chatToolCallStream("run_read_query", JSON.stringify({ sql: FIRST, rationale: "count" }), "call_1");
    };

    const drive = await run.drive([stopsThenAsks]);

    expect(drive.status).toBe("cancelled");
    expect(drive.stopReason).toBe("cancelled");
    // The statement was never sent: only the drive's own catalog reads are here.
    expect(drive.modelStatements).toEqual([]);
    // A user's stop is not reported as a model that would not answer.
    expect(drive.verdict.unmet).toEqual(["cancelled"]);
  });
});
