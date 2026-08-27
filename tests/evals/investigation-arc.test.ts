import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { DEPARTMENTS, type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { answersProse, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";
import { chatToolCallStream } from "../isolated/fixtures/agent-transport";
import { CASES, openCaseRun, summarise } from "./real-model";

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
  // What a plan run may be handed outlives the run that read it (#384), so each
  // scenario states its own starting point instead of inheriting the last one's.
  forgetHeldSnapshots();
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
        "driver-resolved",
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

/*
  WHAT A PLAN RUN SENDS CHANGED ON 2026-08-15, deliberately.

  These tests asserted `drive.statements).toEqual([])` — a plan run reaches no
  database at all. The plan-mode grounding design
  (`docs/superpowers/specs/2026-08-15-plan-mode-sql-generator-design.md`, item 1)
  moved that on the owner's decision, because it made the safe mode's usefulness
  conditional on having already used the unsafe one: a plan run knew this database
  only when an agent run had read it in this same process.

  So the assertions below moved from `statements` to `modelStatements`, which is the
  narrower promise the product actually makes: the server's own catalog reads are
  subtracted, and a statement of the MODEL'S would still show up. Nothing of the
  user's is run, nothing is written, and the model still has no tools.
*/
describe("a planning run is judged by what planning mode can produce", () => {
  /*
    What a plan run has to PRODUCE changed with the same design (item 5 and item 6):
    the deliverable is a statement, and the verdict stops accepting prose that has
    neither a statement nor an explicit refusal in it. So the drives below answer the
    way the contract now asks, and the run that answers in generic prose is asserted
    to fail — which is the defect these evals exist to catch.
  */
  const A_STATEMENT = ["```postgres\n", "SELECT * FROM employees\n```\n\nIt holds one row per person."];

  test("a drafted statement reaches the ledger and counts as answered", async () => {
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse(...A_STATEMENT)]);

    // #341 F1: planning was mute by construction until `closing-statement` existed.
    // `context-captured` joined it when plan mode began reading its own inventory,
    // and `plan-statement-drafted` when the statement became a fact about the run.
    expect(drive.kinds).toEqual([
      "run-started",
      "driver-resolved",
      "context-captured",
      "closing-statement",
      "plan-statement-drafted",
      "run-finished",
    ]);
    expect(drive.modelStatements).toEqual([]);
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("a plan run that lectures instead of drafting is recorded as unanswered", async () => {
    // The 2026-08-15 defect end to end: grounded, talkative, and carrying nothing the
    // user can run. Every field on this ledger called it answered until `no-statement`.
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse("First I would ", "read the employees table.")]);

    expect(drive.kinds).toEqual([
      "run-started",
      "driver-resolved",
      "context-captured",
      "closing-statement",
      "run-finished",
    ]);
    expect(drive.verdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-planning.1",
      unmet: ["no-statement"],
    });
  });

  test("a planning run that says nothing is recorded as unanswered", async () => {
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse("")]);

    // Grounded and still mute: being given the schema is not being given an answer,
    // which is what keeps the verdict a measurement of what the run PRODUCED.
    expect(drive.kinds).toEqual(["run-started", "driver-resolved", "context-captured", "run-finished"]);
    expect(drive.verdict.unmet).toEqual(["no-plan"]);
  });

  /*
    The scenario #384 exists for, end to end: an agent run reads this connection's
    catalog through the audited path, and the plan run that follows is given what it
    read — every table by name, and no catalog read of its own.

    Still here after the grounding design because it is now the FREE FAST PATH rather
    than the only path: what it saves is the capture, and that is what the ledger
    assertion below measures. The plan run still reads the engine's own estimated
    statistics, on this path as on every other, because what a model may conclude has
    to depend on what it was shown and not on which process read a catalog first.

    Both runs are opened before either is driven, which is what makes the ORDER the
    thing under test: the plan run is grounded by the reading, not by having been
    opened after it.
  */
  test("a plan run on a connection this deployment has already read plans against its real tables", async () => {
    const reader = await open("postgres");
    const planner = await open("postgres", { mode: "planning" });

    const reading = await reader.drive([answersProse("Nothing to add.")]);
    const drive = await planner.drive([answersProse(...A_STATEMENT)]);

    expect(reading.statements).toHaveLength(3);
    // No capture, and no catalog re-read: the inventory was given for free. The one
    // statement it did send is the statistics read, which no hold carries.
    //
    // The reuse is NOT free of the ledger, though, and `context-reused` is where this
    // test now says so. A held inventory has no expiry, so a run inheriting one could
    // be reasoning over a schema read hours ago and the ledger could not tell that
    // apart from a capture taken this second. The event carries the reading's age, so
    // the saving is still recorded as a saving rather than as silence.
    expect(drive.kinds).toEqual([
      "run-started",
      "driver-resolved",
      "context-reused",
      "closing-statement",
      "plan-statement-drafted",
      "run-finished",
    ]);
    expect(drive.modelStatements).toEqual([]);
    expect(drive.statements).toHaveLength(1);
    expect(drive.statements[0]).toContain("pg_stats");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });

    const transcript = drive.transcripts[0] ?? "";
    for (const table of DEPARTMENTS) expect(transcript).toContain(table);
    expect(transcript).toContain("so this run did not have to read it again");
  });

  /*
    What replaced "a plan run on a connection nothing has read". A cold PostgreSQL
    connection is no longer the ungrounded case — the run reads its own catalog — so
    the case that still ships is the engine this server cannot ground at all: the
    dialects `CATALOG_COMPOSERS` does not serve. The MySQL preset carries no
    `queryReadOnly`, exactly as the real provider does not, so a run that tried to
    read one here would die on the fixture rather than pass quietly.
  */
  test("a plan run on an engine this server cannot ground says so instead of inventing tables", async () => {
    const run = await open("mysql", { mode: "planning" });

    // And its refusal is an ANSWER: an ungrounded run has no other correct output,
    // so a verdict that failed it would push the model toward inventing table names
    // to pass — which is the very output the ungrounded rules forbid.
    const drive = await run.drive([
      answersProse("NO STATEMENT: ", "this run was given no inventory of this database."),
    ]);

    expect(drive.statements).toEqual([]);
    expect(drive.kinds).not.toContain("context-captured");
    expect(drive.kinds).not.toContain("plan-statement-drafted");
    expect(drive.transcripts[0] ?? "").toContain("No schema inventory is available to this run");
    // The capture's own diagnosis, forwarded rather than replaced (#414). Until then
    // this note was written by `investigation.ts` and named the ENGINE — "on this mysql
    // connection" — which was the true reason while `CATALOG_PLANS` refused a dialect
    // before touching anything. It is not the reason now: a dialect with no catalog
    // plan asks its provider for the same inventory, and this preset's provider is one
    // whose `getSchema()` rejects. Naming the engine there would say MySQL cannot be
    // ground on a build where a real MySQL provider can.
    expect(drive.transcripts[0] ?? "").toContain("this database refused to describe its own schema");
    expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-planning.1", unmet: [] });
  });

  test("a plan run on a cold PostgreSQL connection reads its own inventory and names real tables", async () => {
    // The case the design exists for: nothing held, nothing in the ledger — a
    // restarted process, a second replica, or a user who has never run agent mode.
    const run = await open("postgres", { mode: "planning" });

    const drive = await run.drive([answersProse("I would begin with the engineering table.")]);

    expect(drive.kinds).toContain("context-captured");
    expect(drive.modelStatements).toEqual([]);
    const transcript = drive.transcripts[0] ?? "";
    for (const table of DEPARTMENTS) expect(transcript).toContain(table);
    expect(transcript).toContain("read from this database by this run");
  });
});

/*
  What the real-model eval's `planning-grounded` case can catch, pinned the way
  `empty-result-detection.test.ts` pins its own case: with the case object the live
  job uses, and a scripted model where the live one goes.

  The case is the only measurement of whether a REAL model uses an inventory it was
  handed, so what it can detect must not be established by reading it. Two things
  are asserted — that opening the case grounds its run at all, and that its bar
  separates a plan naming a real table from one naming none.
*/
describe("the planning-grounded case can fail on the defect it was written for", () => {
  const planningCase = CASES.find((entry) => entry.name === "planning-grounded");
  if (!planningCase) throw new Error("no eval case named planning-grounded");

  const openCase = async (): Promise<EvalRun> => {
    const run = await openCaseRun(planningCase);
    runs.push(run);
    return run;
  };

  test("opening the case grounds its run, without the case sending anything itself", async () => {
    const run = await openCase();

    const drive = await run.drive([answersProse("I would start with the engineering table.")]);

    // The warm-up read the catalog, so the case's own run re-read none of it: it
    // sent nothing of the model's, and only the statistics read the hold cannot
    // carry.
    expect(drive.modelStatements).toEqual([]);
    expect(drive.statements).toHaveLength(1);
    expect(drive.transcripts[0] ?? "").toContain("so this run did not have to read it again");
  });

  test("a plan naming no real table is scored unanswered, and one naming a real table is not", async () => {
    // Both drives draft a statement, so BOTH clear the ledger's own bar and what is
    // left under test is the case's judge: `summarise` applies the case's bar only
    // over a run the verdict already accepted, so a lecture here would report
    // `no-statement` and measure nothing about naming.
    const naming = await openCase();
    const named = await naming.drive([answersProse("```postgres\n", "SELECT * FROM engineering\n```")]);
    expect(summarise(planningCase, named).verdict).toBe("answered");

    const vague = await openCase();
    const generic = await vague.drive([answersProse("```postgres\nSELECT relname FROM pg_class\n```")]);
    expect(summarise(planningCase, generic).verdict).toBe("unanswered (plan-names-no-real-table)");
  });

  /*
    Prose is not an identifier. A model writing "the Engineering table", or quoting
    the name as SQL uppercases it, has named the table this bar is about — and a
    judge that missed it would report the defect against a run that did exactly what
    it was supposed to, which is worse than having no bar.
  */
  test("the bar reads a table name the way a sentence writes it, not the way the catalog stores it", async () => {
    const run = await openCase();

    const drive = await run.drive([
      answersProse(
        "```postgres\nSELECT 1\n```\n\nI would start with the Engineering table, then ENGINEERING's indexes.",
      ),
    ]);

    expect(summarise(planningCase, drive).verdict).toBe("answered");
  });
});

describe("the verdict is on the ledger, where a user reads it (B24)", () => {
  test("a run that answered records its verdict beside its status, not instead of it", async () => {
    const run = await open("postgres");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_BY_DEPARTMENT, rationale: "one query" }),
      reportOn("Engineering has the most employees."),
    ]);

    const finished = drive.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.status).toBe("succeeded");
    expect(finished.goalVerdict).toEqual({ outcome: "answered", verifier: "agent-investigation.1" });
    // `unmet` is omitted when the run answered, so the two halves cannot disagree.
    expect(finished.goalVerdict?.unmet).toBeUndefined();
  });

  test("a run that stopped without reporting says so on the ledger, while its status stays succeeded", async () => {
    // The #341 shape: the status word alone has been observed saying the wrong thing.
    const run = await open("postgres");

    const drive = await run.drive([
      callsTool("run_read_query", { sql: COUNT_BY_DEPARTMENT, rationale: "one query" }),
      answersProse("Engineering has the most employees."),
      // The reminder is sent once after a reading; a model that narrates again is
      // stopping rather than hesitating, which is what these scenarios assert.
      answersProse("Engineering has the most employees."),
    ]);

    const finished = drive.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.status).toBe("succeeded");
    expect(finished.goalVerdict).toEqual({
      outcome: "unanswered",
      verifier: "agent-investigation.1",
      unmet: ["no-report"],
    });
  });

  test("a cancelled run records the cancellation as its shortfall, not a missing report", async () => {
    const run = await open("postgres");
    const stopsThenAsks = async (): Promise<Response> => {
      await run.requestCancellation();
      return chatToolCallStream("run_read_query", JSON.stringify({ sql: COUNT_BY_DEPARTMENT }), "call_1");
    };

    const drive = await run.drive([stopsThenAsks]);

    const finished = drive.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.status).toBe("cancelled");
    expect(finished.goalVerdict?.unmet).toEqual(["cancelled"]);
  });
});

describe("the schema's relations reach the model as their own fenced block", () => {
  test("a run is shown the relation graph beside the inventory", async () => {
    const run = await open("sqlite");

    const drive = await run.drive([answersProse("Noted.")]);

    const transcript = drive.transcripts[0] ?? "";
    expect(transcript).toContain("schema relations");
    // The sample's read returns no foreign key, and the block says what that does and
    // does not establish rather than showing an empty list a reader could mistake for
    // "the run did not look" — or for a database that has none.
    expect(transcript).toContain("No foreign key was read for any table in this inventory");
    expect(transcript).toContain("do not report that this database has no foreign keys");
  });

  test("the block is fenced, so identifiers in it are untrusted content like any other", async () => {
    const run = await open("postgres");

    const drive = await run.drive([answersProse("Noted.")]);

    const transcript = drive.transcripts[0] ?? "";
    const opened = transcript.indexOf("schema relations");
    expect(opened).toBeGreaterThan(-1);
    expect(transcript.slice(opened)).toContain("BEGIN UNTRUSTED DATABASE CONTENT");
  });
});

describe("a catalog read that matched nothing is refused, not answered with an empty artifact", () => {
  /*
    The root cause named in this effort's own log and then not fixed for a day, which is why
    it is written down here as well as fixed.

    The repository's own `query-optimization` eval objective is "Why is the employee listing
    query slow?". There is no `employee_listing` object in the sample — "employee listing" is
    the name of a QUERY. Models reasonably called `inspect_schema` for it, the composed
    `sqlite_master` read matched nothing, and `readCatalog` returned that as a COMPLETED step
    with `rowCount: 0` and a citable correlation id. The model then cited it, and
    `restsOnlyOnEmptyResults` scored the run `empty-evidence`: three families produced
    character-identical ledgers doing this, `gemma4:26b` among them.

    The model was not wrong. The server answered a question about a non-existent object with
    success. `profile_table` has had the correct behaviour all along — it refuses a table the
    inventory does not list — and this is the same refusal for the same reason.

    Note what this deliberately does NOT do: it does not refuse an empty RESULT.
    `run_read_query` returning no rows is an answer about the data. This is about a catalog
    read matching no OBJECT, which is an answer about the question.
  */
  test("sqlite: inspecting a table that does not exist is refused with a closed reason", async () => {
    const run = await open("sqlite", {
      // The catalog read is composed by the SERVER, so it is answered through the harness's
      // catalog seam and not through `answer`. Only the lookup naming the missing object is
      // emptied; `null` falls through to the preset, which the grounding reads still need.
      catalogAnswer: (sql) =>
        sql.includes("employee_listing") ? { rows: [], fields: [], rowCount: 0, executionTime: 1 } : null,
    });

    const drive = await run.drive([
      callsTool("inspect_schema", { table: "employee_listing" }, "call_catalog"),
      answersProse("There is no such table, so I have nothing to report."),
      // Two more, because narrating after a tool call earns the report reminder and the
      // drive takes another turn for it.
      answersProse("Still nothing to report."),
      answersProse("Still nothing to report."),
    ]);

    // Refused rather than settled: no artifact exists for the model to cite.
    expect(drive.transcripts[1]).toContain("no object of that name");
    expect(drive.kinds).not.toContain("tool-completed");
  });

  /*
    The same refusal, told a different question, and getting it wrong the other way.

    An index inventory that comes back empty does not mean the object is missing. It means
    the tables exist and carry no secondary index — which is an ANSWER to an optimization
    question, not a failure of one. The sample database declares no `CREATE INDEX` anywhere,
    so `kind: "indexes"` on it returns zero rows every time, and the model was told "There is
    no object of that name in this database" and sent looking for a misspelling it had not
    made.

    That is not a rare corner. `query-optimization`'s first rule ORDERS this call, so it is
    the opening turn of 79 of the 133 optimization runs measured, and it is answered with a
    false sentence whose own advice — check the inventory and inspect a name it lists —
    cannot help, because the inventory lists no indexes either. Since sampling went
    deterministic the dead opening became a dead CERTAINTY: `qwen3:8b` opened this way in 10
    of 10 runs and lost every one.

    It stays a refusal rather than becoming a citable empty artifact: that is the
    `empty-evidence` regression the test above exists for, and nothing here reopens it. What
    changes is only that the sentence is true.
  */
  test("sqlite: an index inventory that is empty says so, rather than denying the object", async () => {
    const run = await open("sqlite", {
      catalogAnswer: (sql) =>
        sql.includes("type='index'") || sql.includes('type="index"')
          ? { rows: [], fields: [], rowCount: 0, executionTime: 1 }
          : null,
    });

    const drive = await run.drive([
      callsTool("inspect_schema", { kind: "indexes" }, "call_indexes"),
      answersProse("Nothing is indexed, so there is nothing to read there."),
      answersProse("Still nothing."),
      answersProse("Still nothing."),
    ]);

    const said = drive.transcripts[1] ?? "";
    expect(said).toContain("no secondary index");
    expect(said).not.toContain("no object of that name");
    // Still a refusal, so there is no empty catalog artifact to rest a report on.
    expect(drive.kinds).not.toContain("tool-completed");
  });

  test("sqlite: an empty RESULT is still an answer, because that is a fact about the data", async () => {
    // The distinction the refusal above must not blur. A read that ran and found no rows has
    // established something; a catalog lookup that matched no object has established nothing.
    const run = await open("sqlite", {
      answer: async (sql) =>
        sql.includes("sqlite_master")
          ? {
              rows: [{ name: "employee", sql: "CREATE TABLE employee (id INTEGER)" }],
              fields: ["name", "sql"],
              rowCount: 1,
              executionTime: 1,
            }
          : { rows: [], fields: ["id"], rowCount: 0, executionTime: 1 },
    });

    const drive = await run.drive([
      callsTool("inspect_schema", { table: "employee" }, "call_catalog"),
      callsTool("run_read_query", { sql: "SELECT id FROM employee WHERE id < 0", rationale: "look" }, "call_read"),
      answersProse("Nothing matched that filter."),
      answersProse("Nothing matched that filter."),
      answersProse("Nothing matched that filter."),
    ]);

    expect(drive.kinds.filter((kind) => kind === "tool-completed")).toHaveLength(2);
  });
});
