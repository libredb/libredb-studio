import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import {
  type Turn,
  callsTool,
  correlationIdIn,
  correlationIdsIn,
  reportOn,
} from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";

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

describe("a run whose present_answer was REFUSED is still asked to present", () => {
  /*
    The defect two models died on, and the same one both times.

    `present_answer` sets a flag the moment it is CALLED, refused or not, and that flag
    disabled the hold which asks a reporting run to present its answer first. So the arc that
    should recover could not:

        one model       profiled a table · presented the PROFILE · refused, correctly, with
                        "present the result of a run_read_query you drafted" · drafted exactly
                        that and ran it · and was never asked to present it. One run then
                        called compose_report five times against a stale citation, the next
                        stopped outright. Both scored nothing.

    The model obeyed the refusal. The mechanism that would have closed the loop had already
    been switched off by the refusal itself.

    Keying the hold on what the LEDGER says — no `answer-composed` entry — rather than on
    whether a call was attempted is what makes the recovery reachable. The bound stays
    `presentReminderLimit`, so a run cannot be held more than its model allows, and a run that
    presented successfully never reaches this branch at all.
  */
  test("the refusal is followed, the read is taken, and the report is held until it is presented", async () => {
    const run = await open({ autoExecute: true });

    const drive = await run.drive([
      READS,
      // A refused presentation. The id is not one this run produced, which is one of the five
      // ways `present_answer` says no — and every one of them used to switch off the hold.
      (): Response =>
        chatToolCallStream(
          "present_answer",
          JSON.stringify({ artifact: "corr-not-of-this-run", presentation: { kind: "table" } }),
          "call_answer_refused",
        ),
      // The run goes for the report with nothing presented. This is the turn that must be held.
      reportOn("The north region brought in the most revenue."),
      asTable,
      reportOn("The north region brought in the most revenue."),
    ]);

    expect(drive.kinds).toContain("call-held");
    expect(drive.kinds).toContain("answer-composed");
    expect(drive.verdict.outcome).toBe("answered");
  });
});

describe("a run that reports having read nothing is left alone", () => {
  /*
    The empty arm of the present-before-report check, and the measurement that closed it.

    Sweeping this cell across ten models turned up three that lost `no-answer` without ever
    reading the data, each arriving differently: one drafted three statements and had all three
    refused by the database, one read only the catalog, one called nothing at all. A sentence was
    written for them — "you have read none" —
    and measured on all three. Not one recovered: their runs lose either way, relabelled
    `no-report` instead of `no-answer`.

    So the sentence and its switch are gone rather than kept switched off. An unearned behaviour
    is the thing `models/profile.ts` exists to refuse, and this test is what keeps it from
    quietly coming back: a run that read nothing is not held, and its report lands.
  */
  test("the report is not held, because no measurement earned a hold there", async () => {
    const run = await open({ autoExecute: true });

    const drive = await run.drive([
      // The schema is the catalog, not the data: the shape two of the three models hit.
      callsTool("inspect_schema", {}, "call_schema"),
      reportOn("The north region brought in the most revenue."),
    ]);

    expect(drive.kinds).not.toContain("call-held");
    expect(drive.kinds).toContain("report-composed");
    // And it scores nothing, which is the honest outcome: an analysis that read no data has no
    // answer to present, and no sentence this server writes changed that on any of the three.
    expect(drive.verdict.outcome).toBe("unanswered");
  });
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
      // One turn more than this arc used to need, and it is the fix above: a run whose
      // presentation was refused is now HELD when it reports with nothing presented, where the
      // refusal used to switch that hold off. This script declines the offer — it reports again
      // rather than presenting — which is what keeps the assertion below about the REFUSAL
      // rather than about a later, valid presentation.
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
    /*
      And the refusal itself IS on the ledger now, under the code the server used.

      It used to be nowhere. `present_answer` settles no step, so a refusal from it wrote
      nothing at all, and a reader could not tell a call the tool sent back from a call the
      model never made. That cost an evening on one evaluated model, whose data-analysis
      runs lose on `no-answer` with neither a hold nor an answer in the ledger: the refused
      call sets the flag that disables the hold which would have asked again, and left no
      trace of having done so. Five different refusals produce that same empty trace, and
      each one implies a different fix.
    */
    expect(drive.kinds).toContain("call-declined");
    /*
      This one carries no `detail`, and that is the rule working rather than a gap: the names
      it refuses with are the ENGINE's, and untrusted text does not enter the ledger under
      this server's name. Only refusals written in our own vocabulary carry one — see the
      shape refusal in `report-citation.test.ts`.
    */
    const refused = drive.events.find((event) => event.kind === "call-declined");
    expect(refused?.kind === "call-declined" && refused.detail).toBeUndefined();
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

/**
 * §4.2's third arm: the report has to be ABOUT the result that was presented
 * (#373 review).
 *
 * A cited report and a presented result were two unconnected facts, so a run could
 * chart artifact A while every claim cited artifact B and still score `answered`.
 * These drives are the #356 half of the fix — the check that the tightened rule is
 * producible by the tools in the order this workflow calls them — and the #350 half,
 * that the model is told it before it has to satisfy it. A unit test can assert the
 * rule; only a drive can show that a run doing what the rules ask meets it.
 */
describe("the tightened verdict is producible, and the model is told it", () => {
  /** A second read, so a run can have TWO results and cite the wrong one. */
  const READS_AGAIN = callsTool(
    "run_read_query",
    { sql: "SELECT region, COUNT(*) AS orders FROM orders GROUP BY region" },
    "call_read_2",
  );

  /** Presents the LATEST result, which is not the one `reportOn` will cite. */
  const presentsLatest = (turn: Turn): Response => {
    const ids = correlationIdsIn(turn.transcript);
    return chatToolCallStream(
      "present_answer",
      JSON.stringify({ artifact: ids.at(-1), presentation: { kind: "table" } }),
      "call_answer",
    );
  };

  test("the arc the workflow's rules ask for satisfies it with nothing added", async () => {
    // Read, present, report — the three-turn arc every other block here drives, and
    // the whole producibility question is whether it still scores `answered`. It does,
    // because `reportOn` cites the result it read, which is the result it presented.
    const run = await open();

    const drive = await run.drive([READS, asChart, reportOn("The north region brought in the most revenue.")]);

    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
    // And the link is real rather than incidental: the claim's evidence names the very
    // artifact the answer nominated.
    const answer = drive.events.find((event) => event.kind === "answer-composed");
    const report = drive.events.find((event) => event.kind === "report-composed");
    if (answer?.kind !== "answer-composed" || report?.kind !== "report-composed") {
      throw new Error("expected an answer and a report on the ledger");
    }
    expect(report.claims[0]?.evidence).toContainEqual({
      source: "artifact",
      correlationId: answer.artifact.correlationId,
    });
  });

  test("a run that reports about a DIFFERENT result it read is scored unanswered", async () => {
    // The adversarial half: a harness that cannot fail on the known defect measures
    // nothing. This run reads twice, presents the second result and writes its only
    // claim about the first — every earlier bar met, and the picture and the prose
    // about different things.
    const run = await open();

    const drive = await run.drive([
      READS,
      READS_AGAIN,
      presentsLatest,
      reportOn("The north region brought in the most revenue."),
    ]);

    expect(drive.kinds).toContain("answer-composed");
    expect(drive.verdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-data-analysis.1",
      unmet: ["answer-uncited"],
    });
  });

  test("the model is told the rule at the start, and told WHICH id to cite when it presents", async () => {
    // #350's half, at both moments it matters: in the opening rules, where a model that
    // is not yet confused reads it, and in what `present_answer` says back, where the
    // id to cite can be named rather than described.
    const run = await open();

    const drive = await run.drive([READS, asChart, reportOn("The north region brought in the most revenue.")]);

    expect(drive.transcripts[0] ?? "").toContain("At least one of those claims must cite the artifact you presented");
    const answer = drive.events.find((event) => event.kind === "answer-composed");
    if (answer?.kind !== "answer-composed") throw new Error("expected an answer on the ledger");
    expect(drive.transcripts[2] ?? "").toContain(`At least one claim must cite ${answer.artifact.correlationId}`);
  });
});

/**
 * A plan is not an answer (#373 review).
 *
 * `present_answer` accepted any artifact this run produced, and a plan is one: an
 * `inspect_plan` step settles like any other and carries a drafted statement, so a run
 * could nominate the engine's DESCRIPTION of a statement as the answer and satisfy the
 * workflow's verdict without ever having read the data. The unit tests prove the
 * refusal exists; this proves it is one a run can act on, and that the arc it forces is
 * the ordinary one.
 */
describe("a plan presented as the answer is refused, and the run recovers", () => {
  const PLANS = callsTool(
    "inspect_plan",
    { sql: "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region" },
    "call_plan",
  );

  /** Presents the plan: the newest artifact on the ledger by the time it is called. */
  const presentsThePlan = (turn: Turn): Response =>
    chatToolCallStream(
      "present_answer",
      JSON.stringify({ artifact: correlationIdsIn(turn.transcript).at(-1), presentation: { kind: "table" } }),
      "call_answer_plan",
    );

  test("the refusal says which kind of result it wanted, and the answer that follows is the read", async () => {
    const run = await open();

    const drive = await run.drive([
      READS,
      PLANS,
      presentsThePlan,
      // The correction: `asTable` names the FIRST artifact in the transcript, which is
      // the read.
      asTable,
      reportOn("The north region brought in the most revenue."),
    ]);

    const refusal = drive.transcripts[3] ?? "";
    expect(refusal).toContain("not a reading of the data");
    // The way out is named, and it is a tool this run has.
    expect(refusal).toContain("run_read_query");
    // Exactly one answer was recorded, and it is the read rather than the plan.
    const answers = drive.events.filter((event) => event.kind === "answer-composed");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.kind === "answer-composed" && answers[0].artifact.operationId).toBe("sql.query.read");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-data-analysis.1", unmet: [] });
  });

  test("the model is told the rule before its first turn, rather than discovering it", async () => {
    const run = await open();

    const drive = await run.drive([READS, asTable, reportOn("The north region brought in the most revenue.")]);

    expect(drive.transcripts[0] ?? "").toContain("Only a result of run_read_query can be presented");
  });
});

/**
 * The harness has to bound a run the way the SERVER bounds it (#373 review).
 *
 * `driveAgentRun` reads the workflow off the persisted record and hands
 * `AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs` to the deadline. The harness
 * opened workflow-specific runs and then gave every drive the INVESTIGATION deadline,
 * so a `data-analysis` eval ran against 450 s where production gives it 900 s — a
 * third of this workflow's wall clock missing from every scenario measured here, and
 * the deadline arriving in evals at a spend no real run would have died at.
 */
describe("a drive is bounded by its own workflow's wall clock, as production bounds it", () => {
  /** Past `investigation`'s deadline, comfortably inside `data-analysis`'s. */
  const BETWEEN =
    (AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs + AGENT_WORKFLOW_BUDGETS["data-analysis"].runDeadlineMs) / 2;

  test("an analysis run still has time at a spend that would have ended an investigation", async () => {
    const run = await open();

    const drive = await run.drive([READS, asChart, reportOn("The north region brought in the most revenue.")], {
      spentMs: BETWEEN,
    });

    expect(drive.stopReason).toBe("report-composed");
    expect(drive.verdict.outcome).toBe("answered");
  });

  test("and the same spend does end an investigation, so the deadline is real", async () => {
    // The pair is what makes the assertion above about the WORKFLOW rather than about
    // the clock never advancing.
    const run = await openEvalRun({ engine: "postgres", objective: "Which department has the most employees?" });
    runs.push(run);

    const drive = await run.drive([READS, reportOn("Engineering has the most employees.")], { spentMs: BETWEEN });

    expect(drive.stopReason).toBe("deadline-exceeded");
  });
});
