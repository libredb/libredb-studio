import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { type Turn, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";
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
