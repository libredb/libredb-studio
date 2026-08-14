import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { type Turn, callsTool, correlationIdIn, reportOn } from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";

/**
 * The `data-analysis` template, driven end to end (§4.4 of
 * `docs/AGENT_ANALYST_DESIGN.md`).
 *
 * §4.4 names three runs as prerequisites to shipping this workflow, and they are the
 * three describe blocks below. Each exists because it is a way the workflow could
 * ship broken while every unit test stayed green:
 *
 * 1. **A chart of a column the result does not have** must be refused AND the run
 *    must recover from the refusal. The unit tests prove the refusal is produced;
 *    only a drive proves the refusal is one a model can act on. A refusal that does
 *    not carry the real column names is a refusal a run answers by guessing again,
 *    and the run then loops on `CHART_COLUMN_NOT_IN_RESULT` to the turn ceiling.
 * 2. **A one-row result** must be presented as a table and score `answered`. §3.4
 *    says a table is a complete answer and not a lesser one; a verdict that scored
 *    it `unanswered` would be a rule stated in terms of an artifact only some valid
 *    answers can produce.
 * 3. **A run with auto-execute unticked** must still score `answered`. This is the
 *    direct regression test for §4.3: the verdict asks what a run PRODUCED, and the
 *    hand-over is only where that answer was delivered. An earlier draft of the
 *    design made the verdict depend on the hand-over, which would have scored a run
 *    `unanswered` for having a checkbox switched off — the #356 shape exactly.
 *
 * Scripted rather than live, as every `tests/evals/*.test.ts` is: the live-model
 * counterpart is `tests/evals/real-model.ts`, which is deliberately not a test file
 * because its verdict is not a function of the code under review.
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

/** One scripted result, in the shape the harness answers a model statement with. */
interface EvalResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly fields: readonly string[];
  readonly rowCount: number;
  readonly executionTime: number;
}

/** The aggregate an analytical run is here to produce: several rows, one numeric column. */
const BY_REGION: EvalResult = {
  rows: [
    { region: "north", net_total: 41_200 },
    { region: "south", net_total: 38_900 },
    { region: "east", net_total: 27_400 },
    { region: "west", net_total: 19_050 },
  ],
  fields: ["region", "net_total"],
  rowCount: 4,
  executionTime: 6,
};

/** §4.4's second case: the whole answer is one row. */
const ONE_ROW: EvalResult = {
  rows: [{ net_total: 126_550 }],
  fields: ["net_total"],
  rowCount: 1,
  executionTime: 3,
};

async function open(options: { readonly result?: EvalResult; readonly autoExecute?: boolean } = {}) {
  const payload = options.result ?? BY_REGION;
  const run = await openEvalRun({
    engine: "postgres",
    workflowType: "data-analysis",
    objective: "Which region brought in the most revenue last quarter?",
    ...(options.autoExecute === undefined ? {} : { autoExecute: options.autoExecute }),
    // Copied per call, because the pipeline owns the rows it is handed.
    answer: async () => ({ ...payload, fields: [...payload.fields], rows: payload.rows.map((row) => ({ ...row })) }),
  });
  runs.push(run);
  return run;
}

const READS = callsTool(
  "run_read_query",
  { sql: "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region" },
  "call_read",
);

/** Presents the result this run already read, however the caller wants it shown. */
const presents =
  (presentation: unknown, callId = "call_answer") =>
  (turn: Turn): Response =>
    chatToolCallStream(
      "present_answer",
      JSON.stringify({ artifact: correlationIdIn(turn.transcript), presentation }),
      callId,
    );

const asTable = presents({ kind: "table" });
const asChart = presents({
  kind: "chart",
  spec: { type: "bar", x: "region", y: ["net_total"], caption: "Revenue by region." },
});

describe("§4.4 case 1: a chart of a column the result does not have", () => {
  test("is refused, and the refusal names the columns that ARE there", async () => {
    const run = await open();

    const drive = await run.drive([
      READS,
      presents({
        kind: "chart",
        // `territory` is not a column of this result. The model invented it, which is
        // the ordinary way this goes wrong: the objective said "region" and the
        // statement aliased it, so the spec is drafted from the question rather than
        // from the result.
        spec: { type: "bar", x: "territory", y: ["net_total"], caption: "Revenue by territory." },
      }),
      reportOn("The north region brought in the most revenue."),
    ]);

    // The refusal reached the model, and it carried the real column names — which is
    // the half that makes it recoverable rather than merely correct.
    const refusal = drive.transcripts[2] ?? "";
    expect(refusal).toContain("A chart may only name columns of the result it presents");
    expect(refusal).toContain("region");
    expect(refusal).toContain("net_total");
    // Nothing was recorded: a refused spec is not a quietly-downgraded table.
    expect(drive.kinds).not.toContain("answer-composed");
  });

  test("and the run recovers on the next turn rather than looping to the ceiling", async () => {
    // The failure §4.4 was written to prevent. A model that cannot act on the refusal
    // re-sends a spec and burns the budget; this asserts the arc a model CAN take —
    // refused, corrected, answered — completes inside its turns.
    const run = await open();

    const drive = await run.drive([
      READS,
      presents({
        kind: "chart",
        spec: { type: "bar", x: "territory", y: ["net_total"], caption: "Revenue by territory." },
      }),
      // The correction: the same chart, over the columns the refusal listed.
      presents(
        {
          kind: "chart",
          spec: { type: "bar", x: "region", y: ["net_total"], caption: "Revenue by region." },
        },
        "call_answer_2",
      ),
      reportOn("The north region brought in the most revenue."),
    ]);

    expect(drive.kinds).toContain("answer-composed");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
    // One statement, not four: the repair happened in the tool layer and never went
    // back to the database.
    expect(drive.modelStatements.length).toBe(1);
  });
});

describe("§4.4 case 2: a result of one row", () => {
  test("is presented as a table and scores answered, not as a lesser answer", async () => {
    const run = await open({ result: ONE_ROW });

    const drive = await run.drive([READS, asTable, reportOn("Revenue last quarter was 126,550.")]);

    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
    const answer = drive.events.find((event) => event.kind === "answer-composed");
    if (answer === undefined || answer.kind !== "answer-composed") throw new Error("expected an answer on the ledger");
    expect(answer.presentation).toEqual({ kind: "table" });
  });

  test("and a CHART of that one row is refused, because a chart of it renders empty", async () => {
    // The other half of the same rule: the table is not merely allowed here, the
    // chart is actively refused — so a run that reaches for a chart is told why and
    // has somewhere to go.
    const run = await open({ result: ONE_ROW });

    const drive = await run.drive([
      READS,
      presents({
        kind: "chart",
        spec: { type: "bar", x: "net_total", y: ["net_total"], caption: "Revenue." },
      }),
      asTable,
      reportOn("Revenue last quarter was 126,550."),
    ]);

    expect(drive.transcripts[2] ?? "").toContain("A chart needs at least two rows");
    expect(drive.verdict.outcome).toBe("answered");
  });
});

describe("§4.4 case 3: auto-execute unticked", () => {
  test("still scores answered — the verdict asks what was produced, not where it went", async () => {
    // The direct regression test for §4.3. This is the default setting, so it is the
    // shape almost every real run has: if the verdict depended on the hand-over, the
    // ordinary run would be the one scored `unanswered`.
    const run = await open({ autoExecute: false });

    const drive = await run.drive([READS, asChart, reportOn("The north region brought in the most revenue.")]);

    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
    const answer = drive.events.find((event) => event.kind === "answer-composed");
    if (answer === undefined || answer.kind !== "answer-composed") throw new Error("expected an answer on the ledger");
    // Nothing was handed anywhere, and the ledger says so in as many words rather
    // than leaving the absence to be inferred.
    expect(answer.handover).toBe("none");
  });

  test("and the verdict is the same with it ticked, so the setting moves nothing", async () => {
    // The pair is the point. One run scoring `answered` proves little; two runs that
    // differ ONLY in the setting and reach the same verdict prove the verdict does
    // not read it.
    const off = await open({ autoExecute: false });
    const on = await open({ autoExecute: true });
    const arc = [READS, asChart, reportOn("The north region brought in the most revenue.")];

    const without = await off.drive(arc);
    const with_ = await on.drive(arc);

    expect(without.verdict).toEqual(with_.verdict);
    expect(with_.verdict.outcome).toBe("answered");
  });
});
