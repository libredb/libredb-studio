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
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
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

const CASES: readonly RealModelCase[] = [
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
    "| case | verdict | status | stop reason | turns | statements | what a good run does |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...outcomes.map(
      (outcome) =>
        `| ${outcome.name} | ${outcome.verdict} | ${outcome.status} | ${outcome.stopReason} | ${outcome.turns} | ${outcome.statements} | ${outcome.note} |`,
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
