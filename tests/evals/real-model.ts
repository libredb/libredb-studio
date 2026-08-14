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
  /**
   * A bar this case adds to the ledger's own verdict, returning the shortfall's id
   * or `undefined`.
   *
   * Consulted only when `verifyRunGoal` already said `answered`, so the ledger's
   * reason dominates — the same rule the workflow verifiers compose by, and for the
   * same reason: reporting a case-specific shortfall about a run that composed no
   * report at all would name the smaller of two problems.
   */
  readonly judge?: (drive: EvalDrive) => string | undefined;
}

const rows = (data: Record<string, unknown>[], fields: string[]) => ({
  rows: data,
  fields,
  rowCount: data.length,
  executionTime: 4,
});

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
 * Every case that reaches a database uses this one, and #331 T7 is why. Until then
 * three of the cases below handed back the same three department rows whatever they
 * were asked, against an inventory of eight department tables of `(id, name)`. A
 * scripted model never notices — it does not read the inventory — but a real one
 * does, and the measurement was unambiguous. The old fixture, driven on 2026-08-14
 * against the reference model: `one-query-answer` failed on `turn-limit` at 16 turns
 * and 16 statements, `one-query-answer-sqlite` at 16 turns and 14, `empty-result` at
 * 16 and 16 — none of them composing a single claim — while `cited-report`, the same
 * question and the same model over this engine, answered in 2 turns on 1 statement.
 * Those three could not measure a REPORT at all, whatever the report contract said:
 * the model was answered about departments it had not asked about, disbelieved the
 * result, and spent the run establishing what the fixture would not tell it. Two runs
 * of the repaired fixture on the same day answered 5/5.
 *
 * The rule this fixture is built to keep, and the one those cases broke: **a scripted
 * engine's answers must be consistent with the inventory the same run handed out.**
 * An eval whose world contradicts itself measures the contradiction and nothing else.
 *
 * It answers the three shapes a live model was observed sending, and the split is
 * from that log rather than from imagination — the first repair covered only counts,
 * and the drive that followed it showed a model asking `SELECT * FROM public.legal`
 * and being answered `{department, headcount}`, which is the same contradiction in a
 * different statement. A catalog question gets the table list; an aggregate gets
 * counts; anything else gets the table's own rows, in the columns the inventory
 * declares.
 */
const peopleIn = (table: string): Record<string, unknown>[] =>
  Array.from({ length: COUNTS[table] ?? 0 }, (_unused, index) => ({ id: index + 1, name: `${table}-${index + 1}` }));

/** What follows a `FROM` or a `JOIN`, which is where a statement says what it reads. */
const READ_TARGETS = /\b(?:from|join)\s+([a-z0-9_."]+)/gi;

/**
 * The tables a statement actually READS.
 *
 * Structural on purpose, and the first shape of this was not: it word-matched the
 * whole statement against the eight table names, one of which is `people`, and this
 * file's own empty-result objective contains that word. An alias, a CTE name or a
 * comment carrying it — `SELECT id FROM legal AS people`, `-- the people with no
 * name` — made a single-table question answer with two tables' rows, which is the
 * self-contradiction the rest of this fixture exists to avoid. What a statement reads
 * is a fact about its structure, so it is read off the structure.
 *
 * No fallback here, and that is the difference from `tablesNamedIn` below: a
 * statement naming no table reads no table, which is what the empty-result bar has to
 * be able to say about `SELECT 1`.
 */
const readTargetsIn = (sql: string): ReadonlySet<string> => {
  const read = new Set<string>();
  for (const match of sql.matchAll(READ_TARGETS)) {
    // `public.legal`, `"legal"` and `legal` are the same table to this world.
    const bare = (match[1] ?? "").replaceAll('"', "").split(".").pop();
    if (bare !== undefined) read.add(bare.toLowerCase());
  }
  return read;
};

/**
 * Which of this world's tables a statement is asking about, for ANSWERING it.
 *
 * The fallback is a property of the engine, not of the statement: a statement naming
 * no table still has to be answered something, and answering it nothing would teach
 * the model to disbelieve the fixture. It is deliberately NOT the predicate a bar
 * judges a citation by — treating "named no table" as "named all eight" would hand
 * `SELECT 1` the whole database as evidence, which is #331 T7's second review finding.
 */
const tablesNamedIn = (sql: string): readonly string[] => {
  const read = readTargetsIn(sql);
  const named = DEPARTMENTS.filter((table) => read.has(table));
  return named.length > 0 ? named : DEPARTMENTS;
};

const countsFor = async (sql: string) => {
  // A catalog question the MODEL wrote itself, and only the ones the engine preset
  // does not already serve (it answers anything naming `information_schema.columns`
  // or `sqlite_master`). So this is a model checking the inventory a second way, and
  // it must find the same eight tables rather than a count of people.
  if (/information_schema|pg_catalog|pg_tables|pg_class/i.test(sql)) {
    return rows(
      DEPARTMENTS.map((table) => ({ table_schema: "public", table_name: table })),
      ["table_schema", "table_name"],
    );
  }
  if (/\bcount\s*\(/i.test(sql)) {
    const counted = tablesNamedIn(sql)
      .map((table) => ({ department: table, headcount: COUNTS[table] ?? 0 }))
      .sort((left, right) => right.headcount - left.headcount);
    return rows(counted, ["department", "headcount"]);
  }
  return rows(tablesNamedIn(sql).flatMap(peopleIn), ["id", "name"]);
};

/**
 * The table the empty-result case asks about, named ONCE.
 *
 * Its objective, the world's answers and the case's own bar are three statements
 * about the same table, and the bar is the one that fails silently if they drift: a
 * question about a table the bar is not watching would score `answered` on any
 * citation at all. Typed as a member of this world's tables, so it cannot name one
 * the inventory does not hold.
 */
const EMPTY_RESULT_TABLE: (typeof DEPARTMENTS)[number] = "legal";

/**
 * Does this statement ask for the rows that have NO name?
 *
 * The complement is removed BEFORE the question is asked, and that is the whole
 * point of the helper. Dispatching on a bare `\bnull\b` was the first repair's shape
 * and it re-created the contradiction it was written to remove: `IS NOT NULL`
 * contains the word, so `SELECT count(*) FROM legal WHERE name IS NOT NULL` answered
 * `0` while `SELECT count(*) FROM legal` answered `5` and `SELECT * FROM legal`
 * returned five rows that all carry names. Checking the complement is what deepening
 * looks like, so it is exactly the model this case wants to reward that met the
 * self-contradicting world.
 *
 * A statement mentioning both — `count(*) FILTER (WHERE name IS NULL)` beside a
 * total — still asks for the unnamed rows, and is answered as such: the facts of
 * this world are that `legal` holds five rows, all named, and none of the three
 * shapes may disagree with the other two.
 */
const asksForUnnamed = (sql: string): boolean => /\bnull\b/i.test(sql.replace(/\bis\s+not\s+null\b/gi, " "));

/**
 * The same world, asked something whose truthful answer is nothing.
 *
 * The empty case's objective used to be "which employees have no department
 * assigned?" against an inventory holding no employees table and no department
 * column — a question the world could not answer, so the run had nowhere to go but
 * round in circles. It now asks about a table that exists, and the engine answers
 * the two shapes of that question the way a real one would: a listing of the
 * offending rows comes back empty, and a COUNT of them comes back as one row saying
 * zero. A count that returned no rows at all would be a shape no engine produces,
 * and re-teaching the model to disbelieve the fixture is exactly what this repair is
 * for. Everything else — the total, the complement, the table's own rows — is
 * answered from the populated world, so the run can establish that the table has
 * five rows and that all five are named.
 */
const noneUnnamed = async (sql: string) => {
  if (!asksForUnnamed(sql)) return countsFor(sql);
  return /\bcount\s*\(/i.test(sql) ? rows([{ unnamed: 0 }], ["unnamed"]) : rows([], ["id", "name"]);
};

/**
 * Did the run ESTABLISH the table's population before saying nothing was missing?
 *
 * The ledger cannot answer this, and the count shape is why. `empty-evidence` fires
 * when EVERY cited result came back empty; a count of the unnamed rows comes back as
 * one row saying zero, which is a non-empty result, so a run that reports "0" as its
 * finding while citing that count is recorded `answered`. That is the #341 defect
 * this case exists to detect, and after the count shape was added the case could no
 * longer fail on it — so the case carries its own bar.
 *
 * What is checked is what the claims RESTED on, which is a fact about the run: the
 * statement behind each cited artifact, resolved through the step that drafted it. A
 * run passes only if some cited statement READ the target table without asking for
 * the unnamed rows — its total, its complement, or its own rows. That is the run
 * establishing that `legal` holds five rows and that all five carry a name, which is
 * the difference the case exists to measure: "established there are none and said so"
 * against "reported the zero it was looking for".
 *
 * Both halves of that predicate were widenings that review had to take back, and the
 * shortfall ids are separate because each names a different way a report can fail to
 * establish it:
 *
 *  - `snapshot-not-population` — no artifact was cited at all. Zero artifact
 *    citations does not mean "no report": `judge` runs only over a run the ledger
 *    ALREADY scored `answered`, so it means every claim rested on the context
 *    snapshot. The snapshot says the table and the column exist; it never says how
 *    many rows are in them.
 *  - `zero-as-finding` — the run cited its null-predicate read and nothing that read
 *    the table otherwise. The original defect.
 *  - `probe-not-population` — the cited statements read no target table at all. This
 *    is `SELECT 1 as x` and `SELECT sqlite_version()`, which are not hypotheticals:
 *    a live model sent exactly those in earlier runs of this case (#350). A bar that
 *    only asked "does this statement avoid the word NULL?" counted them as the
 *    table's population.
 *
 * **What this bar still cannot see**, stated because every widening of what counts as
 * evidence is a step back toward the escape hatch it replaced:
 *
 *  - The model's PROSE, for the reason `goal-verifier.ts` gives — grading the answer
 *    with the answer establishes nothing. It cannot tell a graceful sentence from a
 *    curt one, a hedge from a claim, or a sentence that contradicts the very result
 *    it cites.
 *  - Whether the cited population read was about the right COLUMN, or returned
 *    anything relevant. `SELECT id FROM legal` passes; so would a read of `legal`
 *    that never mentions `name`.
 *  - A read of the target table reached under another name — a view, or a CTE whose
 *    body this fixture never resolves. Nothing in this world has one, so the limit is
 *    latent rather than live.
 *  - Whether the model UNDERSTOOD what it cited. The bar is about what the claims
 *    rest on, and a run can rest on the right result for the wrong reason.
 */
const populationShortfall = (drive: EvalDrive): string | undefined => {
  const draftedFor = new Map<string, string>();
  for (const event of drive.events) {
    if (event.kind === "statement-drafted") draftedFor.set(event.stepId, event.sql);
  }
  const statementBehind = new Map<string, string>();
  for (const event of drive.events) {
    if (event.kind !== "tool-completed") continue;
    const sql = draftedFor.get(event.stepId);
    if (sql !== undefined) statementBehind.set(event.artifact.correlationId, sql);
  }

  const cited = drive.events
    .flatMap((event) => (event.kind === "report-composed" ? event.claims : []))
    .flatMap((claim) => claim.evidence)
    .flatMap((reference) => (reference.source === "artifact" ? [reference.correlationId] : []));
  // The ledger has already accepted this run, so this is a report whose every claim
  // cited the inventory rather than a result — never a run that composed nothing.
  if (cited.length === 0) return "snapshot-not-population";

  const citedStatements = cited.flatMap((correlationId) => {
    const sql = statementBehind.get(correlationId);
    return sql === undefined ? [] : [sql];
  });
  const readTheTable = citedStatements.filter((sql) => readTargetsIn(sql).has(EMPTY_RESULT_TABLE));
  if (readTheTable.some((sql) => !asksForUnnamed(sql))) return undefined;
  return readTheTable.length > 0 ? "zero-as-finding" : "probe-not-population";
};

/**
 * The cases, exported so the shapes that decide a verdict can be driven WITHOUT a
 * credential.
 *
 * `tests/evals/empty-result-detection.test.ts` drives this world with scripted
 * models to pin what the empty-result case is able to catch. A copy of the world in
 * that file would prove something about the copy, so it imports these.
 */
export const CASES: readonly RealModelCase[] = [
  {
    /*
      #350's scenario, and the case the citation contract is measured on.

      Every case here is scored on whether the run WROTE DOWN what it found — the
      verdict requires a report of any agent-mode run — but until #331 T7 repaired
      their engines, three of them could not get that far. This is the thing #350 is
      about: the live runs that motivated it read the answer, held the artifact id,
      and composed nothing, spending their remaining turns on statements with nothing
      to learn in them (`SELECT 1 as x;`, `SELECT sqlite_version();`) while working
      out how to cite what they already had. `claims` in the table below is the column
      that shows it — a run can be `succeeded` with zero.

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
    answer: countsFor,
  },
  {
    name: "one-query-answer-sqlite",
    engine: "sqlite",
    objective: "Which department has the most employees?",
    expectation: "the same, on the engine whose catalog read returns DDL instead of columns",
    answer: countsFor,
  },
  {
    /*
      #341's third defect: a run that treats an empty result as an answer.

      The objective names a table the inventory holds and a column it declares, so the
      question is answerable and its truthful answer is "none". Two shapes of that
      question exist and this world answers both the way an engine would — the listing
      comes back empty, the count comes back as one row saying zero — because a count
      returning NO rows is a shape no engine produces, and a fixture that produced it
      would be teaching the model to disbelieve the world again.

      That count is also what takes the detection out of the ledger's hands, so the
      case carries its own bar rather than claiming one it lost. `empty-evidence`
      requires every cited result to be empty; the count is one row, so a run that
      reports `0` while citing it is recorded `answered` by the verifier. `judge`
      re-establishes the distinction the case was written for, on the only ground a
      machine has: what the claims RESTED on. It passes only a report that cites a
      statement which READ the table without asking for the unnamed rows — the run
      establishing the five rows and the five names before saying none are missing.
      A report resting on the captured inventory alone is `snapshot-not-population`,
      one resting on the null-predicate read is `zero-as-finding`, and one resting on
      statements that touched no table is `probe-not-population`.

      What neither the verdict nor the judge can see is the prose — whether the
      sentence is graceful, hedged or curt — and `populationShortfall` lists that and
      the bar's other blind spots where it is defined, rather than letting this
      comment imply there are none.
    */
    name: "empty-result",
    engine: "postgres",
    objective: `Which people in the ${EMPTY_RESULT_TABLE} table have no name recorded?`,
    expectation: "cites a read of the table's population, not only the zero it was looking for",
    answer: noneUnnamed,
    judge: populationShortfall,
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

export function summarise(testCase: RealModelCase, drive: EvalDrive): CaseOutcome {
  // The ledger's verdict first, and the case's own bar only over a run it passed.
  const shortfall = drive.verdict.outcome === "answered" ? testCase.judge?.(drive) : drive.verdict.unmet.join(", ");
  return {
    name: testCase.name,
    verdict: shortfall === undefined ? "answered" : `unanswered (${shortfall})`,
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
    note: testCase.expectation,
  };
}

/**
 * The run one case is measured on — the world, the objective and the mode.
 *
 * Exported for the same reason `CASES` is: the scripted test that pins what a case
 * can catch has to open the case's OWN world, or it is measuring a second world that
 * happens to look like it today.
 */
export async function openCaseRun(testCase: RealModelCase): Promise<EvalRun> {
  return openEvalRun({
    engine: testCase.engine,
    objective: testCase.objective,
    ...(testCase.name === "planning" ? { mode: "planning" as const } : {}),
    ...(testCase.answer === undefined ? {} : { answer: testCase.answer }),
  });
}

async function runCase(testCase: RealModelCase): Promise<CaseOutcome> {
  let run: EvalRun | undefined;
  try {
    run = await openCaseRun(testCase);
    const drive = await run.driveModel(await createAgentModel());
    return summarise(testCase, drive);
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

// Only when this file IS the command. `bun run agent:eval` runs it as the entry, so
// nothing changes there; a test importing `CASES` gets the world without spending a
// model call on it.
if (import.meta.main) await main();
