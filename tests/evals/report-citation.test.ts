import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  answersProse,
  callsTool,
  offeredCitationsIn,
  promptText,
  reportCitingWhatWasOffered,
} from "../isolated/fixtures/agent-scripted-model";

/**
 * The citation contract, driven end to end (#350).
 *
 * **This is a regression guard, and it is NOT the evidence the issue asks for.** A
 * scripted model already knows the contract, so it can never be confused by one —
 * which is precisely why the defect survived a green suite and a hundred-per-cent
 * coverage gate. The evidence is a live run, and it lives in the PR body.
 *
 * What this CAN hold still is the property a live model depends on and no prose
 * assertion covers: **the object the server puts in front of the model is one the
 * server will then accept.** Four things have to agree for that — `evidenceSchema`,
 * the tool descriptions, `AGENT_RULES`, and the handover text a completed step and a
 * captured snapshot write — and they are in three files. The model here copies what
 * it was offered and nothing else, so if any of the four drifts, the run stops
 * answering here instead of in production.
 *
 * The complementary halves are elsewhere and are deliberately not repeated:
 * `tests/unit/lib/agent/tools.test.ts` parses each description's literal objects
 * through that tool's own schema, and `tests/isolated/agent-investigation.test.ts`
 * asserts the shape reaches all three places a model looks.
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

const AGGREGATE = "SELECT department, count(*) AS headcount FROM employees GROUP BY department ORDER BY 2 DESC";

describe("a run can cite using only what it was shown", () => {
  test("a model that copies the offered citation answers, on both engines", async () => {
    for (const engine of ["postgres", "sqlite"] as const) {
      const run = await open({ engine });
      const drive = await run.drive([
        callsTool("run_read_query", { sql: AGGREGATE, rationale: "count by department" }),
        reportCitingWhatWasOffered("Engineering has the most employees."),
      ]);

      expect(drive.verdict.outcome, engine).toBe("answered");
      expect(drive.stopReason, engine).toBe("report-composed");
      expect(drive.kinds, engine).toContain("report-composed");
    }
  });

  test("the citation it copied is the artifact the run actually produced", async () => {
    const run = await open();
    const drive = await run.drive([
      callsTool("run_read_query", { sql: AGGREGATE, rationale: "count by department" }),
      reportCitingWhatWasOffered("Engineering has the most employees."),
    ]);

    const completed = drive.events.find((event) => event.kind === "tool-completed");
    const report = drive.events.find((event) => event.kind === "report-composed");
    if (completed?.kind !== "tool-completed" || report?.kind !== "report-composed") {
      throw new Error(`expected a completed read and a report, got ${drive.kinds.join(", ")}`);
    }

    // Every reference is one the run minted, not one the fixture invented — the
    // server verified them against its own ledger before recording this entry.
    expect(report.claims[0]?.evidence).toContainEqual({
      source: "artifact",
      correlationId: completed.artifact.correlationId,
    });
  });

  test("the snapshot is citable from the first turn, before any statement is sent", async () => {
    // A run whose answer is in the inventory itself never reads anything, so the
    // snapshot's fingerprint is the ONLY thing it can cite. Without the handover
    // sentence, such a run has no way to compose a report at all.
    const run = await open({ objective: "Which tables does this database have?" });
    const drive = await run.drive([reportCitingWhatWasOffered("The database has eight department tables.")]);

    expect(drive.verdict.outcome).toBe("answered");
    expect(drive.modelStatements).toEqual([]);

    const captured = drive.events.find((event) => event.kind === "context-captured");
    const report = drive.events.find((event) => event.kind === "report-composed");
    if (captured?.kind !== "context-captured" || report?.kind !== "report-composed") {
      throw new Error(`expected a capture and a report, got ${drive.kinds.join(", ")}`);
    }
    expect(report.claims[0]?.evidence).toContainEqual({
      source: "context-snapshot",
      fingerprint: captured.fingerprint,
    });
  });

  test("a planning run is offered no citation, because it can produce none", async () => {
    const offered: unknown[][] = [];
    const run = await open({ mode: "planning" });
    const prose = (turn: Parameters<typeof offeredCitationsIn>[0]) => {
      offered.push(offeredCitationsIn(turn));
      return answersProse("First, read the plan of the report query.")(turn);
    };
    // Two turns, because a grounded plan run that named no statement is now asked for one — and
    // the offer is checked on BOTH, which is stronger than checking the first alone.
    await run.drive([prose, prose]);

    expect(offered).toEqual([[], []]);
  });

  test("the placeholder in the rules is not mistaken for a real id", async () => {
    // The rules carry `{"source":"artifact","correlationId":"<the artifact id …>"}`
    // as a template. A fixture that copied THAT would compose a report citing
    // something no run ever produced — so the extractor drops the placeholders, and
    // this asserts they were there to be dropped.
    const prompts: string[] = [];
    const run = await open();
    await run.drive([
      (turn) => {
        prompts.push(promptText(turn));
        return answersProse("nothing to do")(turn);
      },
    ]);

    expect(prompts[0]).toContain('{"source":"artifact","correlationId":"<');
    expect(prompts[0]).toContain('{"source":"context-snapshot","fingerprint":"<');
  });
});
