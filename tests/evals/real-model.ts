/**
 * The real-model eval (#330 T1). Run with `bun run agent:eval`.
 *
 * Deliberately NOT a `.test.ts` file, so no test runner discovers it and no PR CI
 * job can pick it up. That is the whole point of it being separate: this one costs
 * money, needs a credential, and answers differently on two runs of the same
 * commit. A gate whose verdict is not a function of the code under review does not
 * belong among the required checks — the same argument `security-scan.yml` makes
 * for itself.
 *
 * What it measures is the thing the scripted suites cannot: **model strategy.**
 * `tests/evals/strategy-defects.test.ts` proves the harness SEES a model that
 * re-verifies to the turn ceiling, stops without reporting, or answers `0 rows`.
 * Only a live model can tell you whether the model you are shipping actually does.
 * The scenario is identical in both — same objective, same scripted database, same
 * ledger assertions — so a disagreement between them is about the model and nothing
 * else.
 *
 * The reference model's free tier is 15 requests per minute, and a morning of manual
 * testing exhausted it (#341). Cases are therefore paced, capped, and a rate limit
 * is reported as what it is rather than counted as a failed case.
 */

import { createAgentModel } from "@/lib/agent/model-adapter";
import { LLMRateLimitError } from "@/lib/llm/types";
import { DEPARTMENTS, type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import type { EvalDrive } from "../isolated/fixtures/agent-eval-harness";

interface RealModelCase {
  readonly name: string;
  readonly engine: EvalEngine;
  readonly objective: string;
  /** What a run that did its job looks like, in one sentence a reader can check. */
  readonly expectation: string;
  readonly answer?: (sql: string) => Promise<{
    rows: Record<string, unknown>[];
    fields: string[];
    rowCount: number;
    executionTime: number;
  }>;
}

const rows = (data: Record<string, unknown>[], fields: string[]) => ({
  rows: data,
  fields,
  rowCount: data.length,
  executionTime: 4,
});

const HEADCOUNTS = [
  { department: "engineering", headcount: 41 },
  { department: "sales", headcount: 22 },
  { department: "support", headcount: 17 },
];

/** A count per department table, so a statement that names some gets those. */
const COUNTS: Readonly<Record<string, number>> = {
  engineering: 41,
  sales: 22,
  support: 17,
  finance: 12,
  legal: 5,
  people: 9,
  marketing: 14,
  research: 31,
};

/**
 * A scripted engine whose answers AGREE with the inventory the run captured.
 *
 * The three cases below hand back the same three rows whatever they are asked,
 * against an inventory of eight department tables of `(id, name)`. A scripted model
 * never notices — it does not read the inventory — but a real one does, and #350's
 * measurement showed what that costs: the model counts the eight tables, is answered
 * about three departments it did not ask about, disbelieves the result, and probes
 * to the turn ceiling. The run never gets as far as composing anything, so those
 * cases cannot measure a REPORT at all, whatever the report contract says. Left as
 * they are on purpose — they are #341's observed corpus, and re-shaping them is its
 * own change with its own evidence to produce — but a case that needs the run to
 * reach the end needs an engine that lets it.
 */
const countsFor = async (sql: string) => {
  const named = DEPARTMENTS.filter((table) => new RegExp(`\\b${table}\\b`, "i").test(sql));
  const tables = named.length > 0 ? named : DEPARTMENTS;
  const counted = tables
    .map((table) => ({ department: table, headcount: COUNTS[table] ?? 0 }))
    .sort((left, right) => right.headcount - left.headcount);
  return rows(counted, ["department", "headcount"]);
};

const CASES: readonly RealModelCase[] = [
  {
    /*
      #350's scenario, and the one case here that measures the REPORT.

      The other cases end wherever the model chooses to stop; this one is scored on
      whether the run WROTE DOWN what it found. That is the thing #350 is about: the
      live runs that motivated it read the answer, held the artifact id, and composed
      nothing, spending their remaining turns on statements with nothing to learn in
      them (`SELECT 1 as x;`, `SELECT sqlite_version();`) while working out how to
      cite what they already had. `claims` in the table below is the column that
      shows it — a run can be `succeeded` with zero.

      This case is a MEASUREMENT harness, not evidence by itself: what a given model
      does with it belongs in the run that measured it, not in this comment.
    */
    name: "cited-report",
    engine: "sqlite",
    objective: "Which department has the most employees?",
    expectation: "composes a report citing an artifact it read, rather than re-reading to the turn ceiling",
    answer: countsFor,
  },
  {
    name: "one-query-answer",
    engine: "postgres",
    objective: "Which department has the most employees?",
    expectation: "answers from a single aggregate rather than re-counting each department",
    answer: async () => rows(HEADCOUNTS, ["department", "headcount"]),
  },
  {
    name: "one-query-answer-sqlite",
    engine: "sqlite",
    objective: "Which department has the most employees?",
    expectation: "the same, on the engine whose catalog read returns DDL instead of columns",
    answer: async () => rows(HEADCOUNTS, ["department", "headcount"]),
  },
  {
    name: "empty-result",
    engine: "postgres",
    objective: "Which employees have no department assigned?",
    expectation: "deepens or states uncertainty rather than presenting 0 rows as the finding",
    answer: async () => rows([], ["id", "name"]),
  },
  {
    name: "planning",
    engine: "postgres",
    objective: "How would you find out why the orders report is slow?",
    expectation: "produces a plan in prose; performs zero database operations",
  },
];

/** Between cases, so a burst does not spend the free tier's per-minute allowance. */
const PACING_MS = Number(process.env.AGENT_EVAL_PACING_MS ?? 5_000);

interface CaseOutcome {
  readonly name: string;
  readonly verdict: string;
  readonly status: string;
  readonly stopReason: string;
  readonly turns: number;
  readonly statements: number;
  /** Claims the run wrote down, each carrying a citation the server verified. */
  readonly claims: number;
  readonly note: string;
}

function summarise(name: string, drive: EvalDrive, expectation: string): CaseOutcome {
  return {
    name,
    verdict: drive.verdict.outcome === "answered" ? "answered" : `unanswered (${drive.verdict.unmet.join(", ")})`,
    status: drive.status,
    stopReason: drive.stopReason,
    turns: drive.turns,
    statements: drive.modelStatements.length,
    // Reported alongside the verdict because #350 is about this number being zero:
    // a run can read seven times, hold the answer, and write down none of it.
    claims: drive.events.reduce(
      (total, event) => (event.kind === "report-composed" ? total + event.claims.length : total),
      0,
    ),
    note: expectation,
  };
}

async function runCase(testCase: RealModelCase): Promise<CaseOutcome> {
  let run: EvalRun | undefined;
  try {
    run = await openEvalRun({
      engine: testCase.engine,
      objective: testCase.objective,
      ...(testCase.name === "planning" ? { mode: "planning" as const } : {}),
      ...(testCase.answer === undefined ? {} : { answer: testCase.answer }),
    });
    const drive = await run.driveModel(await createAgentModel());
    return summarise(testCase.name, drive, testCase.expectation);
  } catch (error) {
    // A quota is not a defect in this code, and reporting it as one is exactly the
    // mistake #341 recorded: a rail once told a user their configured, answering
    // provider "is not configured or could not be reached".
    const rateLimited = error instanceof LLMRateLimitError;
    return {
      name: testCase.name,
      verdict: rateLimited ? "model-rate-limited" : "error",
      status: "-",
      stopReason: "-",
      turns: 0,
      statements: 0,
      claims: 0,
      note: error instanceof Error ? error.message : String(error),
    };
  } finally {
    run?.dispose();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const only = process.env.AGENT_EVAL_CASE;
  const selected = only === undefined ? CASES : CASES.filter((testCase) => testCase.name === only);
  if (selected.length === 0) {
    console.error(`no eval case named "${only}"; known: ${CASES.map((c) => c.name).join(", ")}`);
    process.exit(2);
  }

  const outcomes: CaseOutcome[] = [];
  for (const [index, testCase] of selected.entries()) {
    if (index > 0) await sleep(PACING_MS);
    console.error(`- running ${testCase.name} (${testCase.engine})`);
    outcomes.push(await runCase(testCase));
  }

  const lines = [
    "| case | verdict | status | stop reason | turns | statements | claims | what a good run does |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...outcomes.map(
      (outcome) =>
        `| ${outcome.name} | ${outcome.verdict} | ${outcome.status} | ${outcome.stopReason} | ${outcome.turns} | ${outcome.statements} | ${outcome.claims} | ${outcome.note} |`,
    ),
  ];
  console.log(lines.join("\n"));

  const answered = outcomes.filter((outcome) => outcome.verdict === "answered").length;
  const limited = outcomes.filter((outcome) => outcome.verdict === "model-rate-limited").length;
  console.log(`\n${answered}/${outcomes.length} answered${limited > 0 ? `, ${limited} rate-limited` : ""}.`);

  // Non-zero only when a case genuinely did not answer. A rate limit is reported
  // and does not fail the job: it says nothing about the model or the code.
  const unanswered = outcomes.length - answered - limited;
  if (unanswered > 0) process.exit(1);
}

await main();
