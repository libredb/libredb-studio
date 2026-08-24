import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AGENT_TOOL_DEFINITIONS, selectAgentTools } from "@/lib/agent/tools";
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { type Turn, answersProse, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";

/**
 * The evidence the removal of the legacy AI panels rests on (#331 T7).
 *
 * M4 deleted the NL2SQL panel and the AI Autopilot panel on the argument that the
 * agent covers what they did (#331 T2, PR #349). That argument was an opinion. This
 * file is the half of it that can be measured: the two panels' HAPPY PATHS, driven
 * through the run loop as agent runs and asserted against the LEDGER — the event
 * kinds, the statements that reached the database, the findings the server derived
 * and the goal verdict — rather than against what a mock returned.
 *
 * The other half is the honest one and it is not omitted: the last describe block
 * asserts what these runs CANNOT do that the panels did, in the same vocabulary, and
 * `docs/AGENT.md` § "What the removed AI panels did that a run does not" carries the
 * whole list with the code that proves each entry. An uncovered scenario is a reason
 * somebody had for keeping a surface, so it is recorded as a finding rather than left
 * out of the measurement.
 *
 * Deliberately NOT re-asserted here, because they are asserted where they belong and
 * a second copy is a second thing to keep true:
 *
 *  - a recommendation is recorded and never executed — `query-optimization.test.ts`
 *  - a profile sends counts and returns no value — `database-assessment.test.ts`
 *  - the citation the server offers is one the server accepts — `report-citation.test.ts`
 *  - what a real model does with any of this — `real-model.ts`, which needs a key
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

const rows = (data: Record<string, unknown>[], fields: string[]) => ({
  rows: data,
  fields,
  rowCount: data.length,
  executionTime: 4,
});

// ============================================================================
// NL2SQL's happy path: a plain-English question, answered from the user's data
// ============================================================================

/**
 * What the panel did, for a reader who can no longer open it: the user typed a
 * question, the browser pasted a trimmed schema string beside it, the model streamed
 * back one fenced statement plus prose, and the panel offered Run and Load to Editor.
 * As a run the same question is an investigation — the schema is read through the
 * audited catalog path instead of pasted, the statement is drafted with its reason on
 * the ledger, it is executed under the read-only profile, and the answer is a claim
 * carrying the id of the result it rests on.
 */
const QUESTION = "Which department has the most employees?";
const ANSWERING_QUERY = "SELECT department, count(*) AS headcount FROM employees GROUP BY department ORDER BY 2 DESC";
const RATIONALE = "one aggregate answers the whole question";

const HEADCOUNTS = [
  { department: "engineering", headcount: 41 },
  { department: "sales", headcount: 22 },
  { department: "support", headcount: 17 },
];

async function openQuestion(engine: EvalEngine): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    objective: QUESTION,
    answer: async () => rows(HEADCOUNTS, ["department", "headcount"]),
  });
  runs.push(run);
  return run;
}

const asksTheQuestion = () => callsTool("run_read_query", { sql: ANSWERING_QUERY, rationale: RATIONALE });

describe("NL2SQL's happy path, as an agent run", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: a plain-English question is answered, and the ledger records the answering`, async () => {
      const run = await openQuestion(engine);

      const drive = await run.drive([asksTheQuestion(), reportOn("Engineering has the most employees, at 41.")]);

      expect(drive.kinds).toEqual([
        "run-started",
        "driver-resolved",
        "context-captured",
        "statement-drafted",
        "tool-invoked",
        "tool-completed",
        "report-composed",
        "run-finished",
      ]);
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1", unmet: [] });
    });

    test(`${engine}: the statement AND the reason for it are on the ledger, which is what the panel showed`, async () => {
      // The panel's product was two things on screen: a fenced statement the user
      // could read, and prose explaining it. Both survive the removal, in a place a
      // reader can go back to after the run has ended.
      const run = await openQuestion(engine);

      const drive = await run.drive([asksTheQuestion(), reportOn("Engineering has the most employees, at 41.")]);

      const drafted = drive.events.find((event) => event.kind === "statement-drafted");
      if (drafted?.kind !== "statement-drafted") throw new Error("expected a drafted statement");
      expect(drafted.sql).toBe(ANSWERING_QUERY);
      expect(drafted.rationale).toBe(RATIONALE);
      // And it is the statement that actually reached the database, not a second one.
      expect(drive.modelStatements).toEqual([ANSWERING_QUERY]);
    });

    test(`${engine}: the schema was read by the run, and the rows come back fenced`, async () => {
      // The panel assembled its schema string in the BROWSER from the connection's
      // cached table list and posted it to the model with the question. A run reads
      // the catalog itself, through the same audited operation layer as any other
      // read, and every row that crosses into a prompt is fenced as untrusted.
      const run = await openQuestion(engine);

      const drive = await run.drive([asksTheQuestion(), reportOn("Engineering has the most employees, at 41.")]);

      expect(drive.statements).toHaveLength(run.engine.catalogReads.length + 1);
      expect(drive.transcripts[0] ?? "").toContain("BEGIN UNTRUSTED DATABASE CONTENT");
      expect(drive.transcripts[1] ?? "").toContain("BEGIN UNTRUSTED DATABASE CONTENT");
    });

    test(`${engine}: question, statement, result and claim are one chain a reader can follow`, async () => {
      // What the panel could not do at all: its answer was a stream of text with no
      // durable link to the result the user then ran. Here the claim names the
      // artifact, the artifact belongs to the step, and the step is the statement.
      const run = await openQuestion(engine);

      const drive = await run.drive([asksTheQuestion(), reportOn("Engineering has the most employees, at 41.")]);

      const drafted = drive.events.find((event) => event.kind === "statement-drafted");
      const completed = drive.events.find((event) => event.kind === "tool-completed");
      const report = drive.events.find((event) => event.kind === "report-composed");
      if (drafted?.kind !== "statement-drafted" || completed?.kind !== "tool-completed") {
        throw new Error(`expected a drafted statement and its result, got ${drive.kinds.join(", ")}`);
      }
      if (report?.kind !== "report-composed") throw new Error("expected a report");

      expect(completed.stepId).toBe(drafted.stepId);
      expect(completed.artifact.summary.rowCount).toBe(HEADCOUNTS.length);
      expect(report.claims[0]?.evidence).toContainEqual({
        source: "artifact",
        correlationId: completed.artifact.correlationId,
      });
    });
  }
});

// ============================================================================
// Autopilot's happy path: "tell me what is wrong with this database"
// ============================================================================

/**
 * The Autopilot panel had one button. It pre-fetched `/api/db/monitoring` for the
 * connection, posted slow queries, index statistics, table statistics and a schema
 * digest to `/api/ai/autopilot`, and rendered whatever markdown came back under a
 * fixed template: a performance score, critical issues, the top five slow queries,
 * index recommendations, maintenance tasks and an action plan.
 *
 * The part of that a run covers is the part that rests on the database's own state:
 * a `database-assessment` run profiles a table, and the findings it records are the
 * server's — counted inside the database, or derived from the inventory the run
 * captured. The part it does not cover is everything that came from the monitoring
 * endpoint, and that is the last describe block rather than a silence.
 */
const ASSESSMENT = "Tell me what is wrong with this database.";

/** One under-populated, unindexed foreign key — the shape Autopilot's index section was for. */
const PG_COLUMNS = [
  { table_schema: "public", table_name: "employees", column_name: "emp_no", data_type: "integer", is_nullable: "NO" },
  {
    table_schema: "public",
    table_name: "employees",
    column_name: "department_id",
    data_type: "integer",
    is_nullable: "YES",
  },
  { table_schema: "public", table_name: "employees", column_name: "hired_on", data_type: "date", is_nullable: "YES" },
  { table_schema: "public", table_name: "departments", column_name: "id", data_type: "integer", is_nullable: "NO" },
];

const PG_RELATIONS = [
  {
    table_schema: "public",
    table_name: "employees",
    column_name: "department_id",
    referenced_schema: "public",
    referenced_table: "departments",
    referenced_column: "id",
  },
];

/** The primary key only: nothing leads on `department_id`. */
const PG_INDEXES = [
  {
    table_schema: "public",
    table_name: "employees",
    index_name: "employees_pkey",
    column_name: "emp_no",
    is_unique: true,
    is_primary: true,
  },
];

const SQLITE_OBJECTS = [
  {
    name: "employees",
    type: "table",
    sql: "CREATE TABLE employees (emp_no INTEGER PRIMARY KEY, department_id INTEGER REFERENCES departments(id), hired_on TEXT)",
  },
  { name: "departments", type: "table", sql: "CREATE TABLE departments (id INTEGER PRIMARY KEY)" },
];

/**
 * The inventory each engine hands out, in that engine's own catalog shape.
 *
 * Keyed on the two engines that ANSWER a composed statement rather than on every
 * preset the harness offers: the third one exists for the operations workflow, which
 * composes no catalog and sends no statement, so an entry here would be a fixture for
 * a call that cannot happen.
 */
const INVENTORY: Readonly<Record<"postgres" | "sqlite", (sql: string) => ReturnType<typeof rows> | null>> = {
  postgres: (sql) => {
    if (sql.includes("information_schema.columns")) {
      return rows(PG_COLUMNS, ["table_schema", "table_name", "column_name", "data_type", "is_nullable"]);
    }
    if (sql.includes("pg_constraint")) {
      return rows(PG_RELATIONS, [
        "table_schema",
        "table_name",
        "column_name",
        "referenced_schema",
        "referenced_table",
        "referenced_column",
      ]);
    }
    if (sql.includes("pg_index")) {
      return rows(PG_INDEXES, ["table_schema", "table_name", "index_name", "column_name", "is_unique", "is_primary"]);
    }
    return null;
  },
  sqlite: (sql) => {
    if (!sql.includes("sqlite_master")) return null;
    return sql.includes("'index'")
      ? rows([], ["name", "tbl_name", "sql"])
      : rows(SQLITE_OBJECTS, ["name", "type", "sql"]);
  },
};

/** 1200 rows, and 900 of them have no department. */
const PROFILE_ROW = { row_count: 1200, present_0: 1200, present_1: 300, present_2: 1200 };

async function openAssessment(engine: "postgres" | "sqlite"): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    workflowType: "database-assessment",
    objective: ASSESSMENT,
    catalogAnswer: INVENTORY[engine],
    answer: async (sql) => {
      if (!sql.includes("count(")) return rows([{ x: 1 }], ["x"]);
      return rows([PROFILE_ROW], Object.keys(PROFILE_ROW));
    },
  });
  runs.push(run);
  return run;
}

const profiles = callsTool("profile_table", { table: "employees" }, "call_profile");

describe("Autopilot's happy path, as an agent run", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: "what is wrong with this database" profiles a table and answers`, async () => {
      const run = await openAssessment(engine);

      const drive = await run.drive([
        profiles,
        reportOn("Most employees have no department, and the key is unindexed."),
      ]);

      expect(drive.kinds).toEqual([
        "run-started",
        "driver-resolved",
        "context-captured",
        "tool-invoked",
        "table-profiled",
        "tool-completed",
        "report-composed",
        "run-finished",
      ]);
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-database-assessment.1", unmet: [] });
    });

    test(`${engine}: the critical issue and the index recommendation are the SERVER's, not the model's prose`, async () => {
      // Autopilot's two most useful sections were "critical issues" and "index
      // recommendations", and both were whatever the model wrote. Here the equivalent
      // findings are mechanical: one is a ratio counted inside the database, the other
      // is read off the inventory the run captured. The model chose a table and a
      // depth, and nothing else in this assertion came from it.
      const run = await openAssessment(engine);

      const drive = await run.drive([profiles, reportOn("Most employees have no department.")]);

      const profiled = drive.events.find((event) => event.kind === "table-profiled");
      if (profiled?.kind !== "table-profiled") throw new Error("expected a profile");
      expect(profiled.profile.rowCount).toBe(1200);
      expect(profiled.profile.findings).toEqual([
        { code: "high_null", column: "department_id", detail: "75% of 1200 rows have no value here." },
        {
          code: "fk_unindexed",
          column: "department_id",
          detail: "No index in the captured inventory leads on this foreign-key column.",
        },
      ]);
    });

    test(`${engine}: the report rests on the profile, so the assessment's claims are checkable`, async () => {
      const run = await openAssessment(engine);

      const drive = await run.drive([profiles, reportOn("Most employees have no department.")]);

      const profiled = drive.events.find((event) => event.kind === "table-profiled");
      const report = drive.events.find((event) => event.kind === "report-composed");
      if (profiled?.kind !== "table-profiled" || report?.kind !== "report-composed") {
        throw new Error(`expected a profile and a report, got ${drive.kinds.join(", ")}`);
      }
      expect(report.claims[0]?.evidence).toContainEqual({
        source: "artifact",
        correlationId: profiled.artifact.correlationId,
      });
    });
  }
});

// ============================================================================
// What the panels did that these runs do NOT
// ============================================================================

/**
 * Each of these is a capability a user had before M4 and does not have now. They are
 * asserted rather than described so that the day one of them becomes possible, the
 * assertion fails and somebody has to decide what the honest sentence is.
 *
 * **What an absence has to be asserted against is the tool SET, not a name.** The
 * monitoring case drove a run asking for an invented `read_monitoring` and asserted
 * the generic unknown-tool sentence — which is true of every string that is not a
 * tool, so a monitoring tool shipped under any other name (B27 calls it "a monitor
 * snapshot") would have left it green while the promise above went quietly false.
 * The runtime refusal is still driven, because it is what a model meets; what carries
 * the promise is the assertion over the members.
 *
 * The two LARGEST losses are not here and cannot be: the agent is standalone-only,
 * and a model that cannot call tools is refused before a run opens. Neither is a
 * property of a run, so neither can be measured by driving one — they are asserted
 * in `tests/unit/agent-package-boundary.test.ts` and
 * `tests/isolated/agent-capability-gate.test.ts`, and they head the list in
 * `docs/AGENT.md` § "What the removed AI panels did that a run does not", which is
 * where the whole list lives with the code that proves each entry.
 */
describe("what the removed panels did that these runs do not", () => {
  test("the monitoring member EXISTS now, and reaches exactly one workflow (B17, B27 resolved)", () => {
    // This assertion used to say the opposite, and its own docblock said what to do
    // on the day it stopped being true: decide what the honest sentence is. That day
    // is the `operations` workflow. Autopilot's whole input came from
    // `/api/db/monitoring` — slow queries, index usage, cache and connection metrics
    // — and `inspect_operations` reads those same provider methods, under a
    // descriptor B27 asked for by name ("a metrics read needs a descriptor shape for
    // non-SQL reads").
    //
    // What is asserted is still the tool SET rather than a name, for the reason the
    // old shape got wrong: a member added under any other name has to land here.
    expect(Object.keys(AGENT_TOOL_DEFINITIONS).sort()).toEqual([
      "compare_plans",
      "compose_report",
      "inspect_operations",
      "inspect_plan",
      "inspect_schema",
      // Registered, and offered by no workflow yet — asserted over every workflow
      // type in `tests/unit/lib/agent/tools.test.ts`.
      "present_answer",
      "profile_table",
      "recommend_change",
      "run_read_query",
    ]);
    // Four canonical operations: three composed SQL, and the curated read that names
    // no statement at all. That fourth id is the thing B27 said did not exist.
    expect([...new Set(Object.values(AGENT_TOOL_DEFINITIONS).map((tool) => tool.operationId))].sort()).toEqual([
      "db.operations.read",
      "sql.explain.estimate",
      "sql.query.read",
      "sql.table.profile",
      undefined,
    ]);
    // The honest bound on the restored capability: it reaches ONE workflow. An
    // assessment run — Autopilot's closer counterpart — is still not offered it, so
    // "the agent can read monitoring data" is only true of a run opened to Operate.
    expect(selectAgentTools({ mode: "agent", workflowType: "database-assessment" }).map((tool) => tool.name)).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "compose_report",
      "profile_table",
    ]);
    expect(selectAgentTools({ mode: "agent", workflowType: "operations" }).map((tool) => tool.name)).toEqual([
      "inspect_operations",
      "recommend_change",
      "compose_report",
    ]);
  });

  test("a model that asks for monitoring anyway is told there is no such tool, and sends no statement of its own", async () => {
    // The runtime half of the same fact: the refusal a model actually meets. The
    // run is NOT statement-free — it captured its own context first, which is three
    // catalog reads on this engine — so what is asserted is that it sent nothing of
    // its own, which is the true sentence and the one `docs/AGENT.md` now carries.
    const run = await openAssessment("postgres");

    const drive = await run.drive([
      (turn: Turn) => {
        void turn;
        return chatToolCallStream("read_monitoring", JSON.stringify({ slowQueryLimit: 20 }), "call_monitor");
      },
      answersProse("I cannot read live monitoring from here."),
    ]);

    // The transcript is the messages JSON-encoded, so the tool name arrives escaped.
    expect(drive.transcripts[1] ?? "").toContain(String.raw`There is no tool called \"read_monitoring\"`);
    expect(drive.modelStatements).toEqual([]);
    expect(drive.statements).toHaveLength(run.engine.catalogReads.length);
    expect(drive.verdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-database-assessment.1",
      unmet: ["no-report"],
    });
  });

  test("a claim citing an artifact this run never produced is refused, so Autopilot's score cannot be cited to nothing", async () => {
    // The panel's report opened with "Performance Score: NN/100", which rested on
    // nothing in particular. What the server checks is the CITATION: every claim must
    // name an artifact this run produced or the snapshot it captured, and an invented
    // correlation id is refused against the run's own ledger.
    //
    // What it does NOT check is the claim's TEXT. A fabricated score citing a real
    // artifact would be accepted, so the honest statement is "a number cited to
    // nothing cannot be reported", not "a number nobody read cannot be reported" —
    // the sentence `docs/AGENT.md` used to carry.
    const run = await openQuestion("postgres");

    const drive = await run.drive([
      asksTheQuestion(),
      (turn: Turn) => {
        void turn;
        return chatToolCallStream(
          "compose_report",
          JSON.stringify({
            claims: [
              {
                claim: "Performance score: 72/100.",
                evidence: [{ source: "artifact", correlationId: "00000000-0000-4000-8000-000000000000" }],
              },
            ],
          }),
          "call_report",
        );
      },
      answersProse("I cannot support that number."),
      // The reminder is sent once after a reading; a model that narrates again is
      // stopping rather than hesitating, which is what these scenarios assert.
      answersProse("I cannot support that number."),
    ]);

    expect(drive.transcripts[2] ?? "").toContain("does not match anything this run produced");
    expect(drive.kinds).not.toContain("report-composed");
    expect(drive.verdict).toEqual({ outcome: "unanswered", verifier: "agent-investigation.1", unmet: ["no-report"] });
  });

  test("an investigation cannot propose a statement it did not run", async () => {
    // Half of this one IS covered and the honest wording matters. The rail renders
    // "Apply to editor" for every statement a run drafted and for a recommendation
    // (`src/components/agent/timeline.ts`, the `statement-drafted` and
    // `recommendation` cases both carry `applySql`), so NL2SQL's Load to Editor
    // survives. What does not survive is the panels' one-click Run/Execute, and this:
    // a statement the run never sent. NL2SQL emitted whatever the model wrote,
    // including DDL, and offered it. Here the only tool that proposes an unexecuted
    // statement is `recommend_change`, which belongs to the query-optimization
    // workflow — an investigation, which is what a plain-English question opens, has
    // no way to propose anything at all.
    const run = await openQuestion("postgres");

    const drive = await run.drive([
      (turn: Turn) => {
        void turn;
        return chatToolCallStream(
          "recommend_change",
          JSON.stringify({
            change: "index",
            statement: "CREATE INDEX employees_department_idx ON employees (department)",
            rationale: "the question filtered on it",
            evidence: [{ source: "artifact", correlationId: "00000000-0000-4000-8000-000000000000" }],
          }),
          "call_recommend",
        );
      },
      answersProse("I can only report what I read."),
    ]);

    expect(drive.transcripts[1] ?? "").toContain(String.raw`There is no tool called \"recommend_change\"`);
    expect(drive.kinds).not.toContain("recommendation");
  });

  test("there is no second question: a follow-up is a new run that starts from nothing", async () => {
    // NL2SQL replayed the whole conversation on every request, so "and how many in
    // the second one?" was answerable. A run's objective is fixed when it starts and
    // no ledger event records a later question, so the follow-up is a different run —
    // which re-reads the schema and knows nothing the first one established.
    const first = await openQuestion("postgres");
    const answered = await first.drive([asksTheQuestion(), reportOn("Engineering has the most employees, at 41.")]);
    expect(answered.verdict.outcome).toBe("answered");

    const followUp = await openEvalRun({
      objective: "And how many people are in the second largest one?",
      answer: async () => rows(HEADCOUNTS, ["department", "headcount"]),
    });
    runs.push(followUp);
    const second = await followUp.drive([answersProse("I would count the sales table.")]);

    expect(followUp.runId).not.toBe(first.runId);
    const prompt = second.transcripts[0] ?? "";
    expect(prompt).toContain("And how many people are in the second largest one?");
    expect(prompt).not.toContain("Engineering has the most employees");
    // And it pays for what the first run already knew: the catalog is read again.
    expect(second.statements).toHaveLength(followUp.engine.catalogReads.length);
  });
});
