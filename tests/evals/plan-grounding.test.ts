import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { QueryError } from "@/lib/db/errors";
import type { AgentRunEvent } from "@/lib/agent/types";
import { UNTRUSTED_CONTENT_END } from "@/lib/agent/untrusted-content";
import {
  DEPARTMENTS,
  type EvalDrive,
  type EvalEngine,
  type EvalRun,
  openEvalRun,
} from "../isolated/fixtures/agent-eval-harness";
import { type ScriptedTurn, answersProse, modelOver, scriptedModel } from "../isolated/fixtures/agent-scripted-model";

/**
 * Plan mode, driven end to end against the run loop, on every engine the harness
 * carries — including one this server cannot ground at all.
 *
 * This is the eval-level half of the plan-mode grounding design of 2026-08-15
 * (`docs/superpowers/specs/2026-08-15-plan-mode-sql-generator-design.md`, work items
 * 2 and 3). The unit tests assert what each piece composes and packs; what only a
 * drive can show is what a whole planning run DID: which statements reached the
 * engine, what the model was actually sent, and what the ledger records afterwards.
 *
 * The invariant is the narrower one the product sells, and it replaced "a plan run
 * reaches no database" deliberately:
 *
 *  - a plan run runs NO STATEMENT OF THE USER'S. `modelStatements` is the instrument
 *    — the harness subtracts the server's own grounding reads and nothing else, so a
 *    run that sent something of the model's shows it here rather than in a count.
 *  - it is grounded from a COLD PROCESS. Every run below opens on its own data
 *    directory with nothing held and nothing in its ledger, which is exactly the
 *    state #384's process-held inventory could not serve: after a restart, on a
 *    second replica, or for a user who had not already run agent mode.
 *  - an engine that cannot be grounded produces a run that SAYS SO, because the rules
 *    that keep an ungrounded plan from inventing table names depend on that flag
 *    being honest.
 *
 * The statistics assertions are about ABSENCE as much as about numbers. Only
 * `engineering` is analysed in either preset; the other seven tables are listed as
 * having no row estimate, never omitted and never shown as zero.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  // The audited execution layer writes one JSON line per operation to stdout.
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  // THE COLD PROCESS, expressed rather than assumed. The held inventory is a
  // module-level map in this process, and every engine preset here opens on the same
  // connection id (`conn_eval`), so without this the second test in the file would be
  // handed the FIRST one's inventory — a PostgreSQL schema shown to a SQLite run.
  // That is a property of the fixture's ids and not of the hold, but it is also the
  // shape of a hazard worth naming: the hold is keyed on a connection id alone, and a
  // connection whose id survives being re-pointed at another database would be served
  // the old one's tables. Recorded for `docs/BACKLOG.md` rather than fixed here.
  forgetHeldSnapshots();
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

async function openPlan(engine: EvalEngine): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    mode: "planning",
    objective: "Which department has the most employees?",
  });
  runs.push(run);
  return run;
}

// Two turns of the same prose: a grounded plan run that names no statement is now asked for
// one, and a model with nothing to add says the same thing again. The verdict is unchanged.
const PLAN = [
  answersProse("I would read the engineering table and count its rows."),
  answersProse("I would read the engineering table and count its rows."),
];

describe("a plan run on a cold process grounds itself in the database it is about", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: names this database's real tables, and sends no statement of the user's`, async () => {
      const run = await openPlan(engine);

      const drive = await run.drive(PLAN);

      // Nothing was held and nothing was in the ledger, so the inventory is one this
      // run read itself — recorded, so a later drive of the same run reuses it.
      expect(drive.kinds).toContain("context-captured");
      expect(drive.modelStatements).toEqual([]);
      const sent = drive.transcripts[0] ?? "";
      for (const table of DEPARTMENTS) expect(sent).toContain(table);
      expect(sent).toContain("read from this database by this run");
      expect(drive.status).toBe("succeeded");
    });

    test(`${engine}: the numbers are labelled estimates, and a table with none is listed as having none`, async () => {
      const run = await openPlan(engine);

      const drive = await run.drive(PLAN);

      const sent = drive.transcripts[0] ?? "";
      // Only `engineering` is analysed in either preset. Both halves are asserted,
      // because the failure this whole block exists to prevent is silence being read
      // as zero: the seven unanalysed tables must be present AND unknown.
      expect(sent).toContain("roughly 41 row(s), estimated");
      expect(sent).toContain("no row estimate recorded; its size is unknown");
      expect(sent).toContain("ENGINE'S OWN ESTIMATE");
      expect(sent).toContain("it is not an empty table");
      // And the rules tell the model what an estimate is worth, rather than leaving
      // it to quote one as a measurement.
      expect(sent).toContain("never one you may treat as empty or small");
    });
  }

  test("postgres: a ratio distinct estimate is converted against the row estimate and marked derived", async () => {
    // `n_distinct` of -0.5 over 41 estimated rows. The conversion is the reader's
    // job precisely so the result can be LABELLED derived — the composed read emits
    // the ratio raw, and a number wearing the engine's name would be a precision
    // claim nobody can support.
    const run = await openPlan("postgres");

    const drive = await run.drive(PLAN);

    expect(drive.transcripts[0] ?? "").toContain("about 21 distinct value(s), derived from the engine's ratio");
    expect(drive.transcripts[0] ?? "").toContain("25.0% null, estimated");
  });

  test("sqlite: says once that this engine records no per-column distribution at all", async () => {
    // Not a gap left per column for the model to interpret. SQLite holds no distinct
    // count and no null fraction anywhere, and a limit stated once is the difference
    // between a model that knows it cannot have them and one that assumes zero.
    const run = await openPlan("sqlite");

    const drive = await run.drive(PLAN);

    expect(drive.transcripts[0] ?? "").toContain("This engine records no per-column distinct count or null fraction");
  });
});

describe("a plan run on an engine this server cannot ground says so", () => {
  test("mysql: no statement is sent, nothing is captured, and the run is told it has seen nothing", async () => {
    // `CATALOG_COMPOSERS` covers PostgreSQL and SQLite and MySQL is not one of them,
    // so no catalog STATEMENT is composed here — which is what `drive.statements`
    // pins. Since #414 that is no longer the whole reason the run is ungrounded: the
    // dialect falls through to its PROVIDER instead, and this preset's provider
    // carries no `getSchema` (nor `queryReadOnly`), so it stands in for an engine
    // whose provider cannot describe itself.
    const run = await openPlan("mysql");

    const drive = await run.drive(PLAN);

    expect(drive.statements).toEqual([]);
    expect(drive.kinds).not.toContain("context-captured");
    const sent = drive.transcripts[0] ?? "";
    // The capture's own diagnosis (#414). This asserted "on this mysql connection"
    // while the note was written here and named the engine; the engine is not the
    // reason now, and saying it would report a property of MySQL on a build where a
    // real MySQL provider describes itself perfectly well. What stopped THIS run is a
    // `getSchema()` that rejected — the only way a provider fails to describe a
    // database, since the method is required on every one of them — so the engine's own
    // words are what the run is told, and they arrive fenced because the database wrote
    // them.
    expect(sent).toContain("this database refused to describe its own schema");
    expect(sent).toContain(UNTRUSTED_CONTENT_END);
    // And the server's own sentence begins on its OWN line: a fence whose terminator
    // shares a line with this server's prose is not a boundary a reader can see.
    // Escaped through `JSON.stringify` because `sent` is the serialised request body:
    // a real newline in the message is `\n` in the text this reads.
    expect(sent).toContain(
      JSON.stringify(`${UNTRUSTED_CONTENT_END}\nSo nothing about this database has been established for you`).slice(
        1,
        -1,
      ),
    );
    expect(sent).toContain("No schema inventory is available to this run");
    // Never in the capture's own words, which send a model to `inspect_schema`: a
    // planning run has no tools, and naming one it does not have is the #350 failure.
    expect(sent).not.toContain("inspect_schema");
    expect(drive.status).toBe("succeeded");
  });
});

/*
  B54. A refused capture used to leave the ledger silent, which broke the rule
  `docs/llms/setup.md` states about it: every run writes its ledger, and that is the
  authority on what the run did. It was the authority only for a capture that
  SUCCEEDED — the refusal path pushed a sentence into the prompt and returned, so the
  849-byte ledger of the AlloyDB Omni run the entry measured named no catalog read, no
  reason code and no row count, and the only record that the run was ungrounded was the
  model's own prose. The trap that makes it worse is already on file here: a missing
  event reads as work that was not needed rather than knowledge that was lost.

  `context-unavailable` is its own kind rather than a `context-captured` carrying an
  absence, and the tests below assert both halves of why. A refused capture has no
  honest `fingerprint` and no honest `tableCount`, so the absence rule (#477) forbids
  the variant; and every reader that asks `kind === "context-captured"` —
  `reusableSnapshot`, the grounding check in `tools.ts`, the timeline — treats the entry
  as PROOF that an inventory exists, so one that carried a refusal would poison all
  three.
*/
/** One ledger entry of a given kind, narrowed, so an assertion can read its own fields. */
const eventOfKind = <K extends AgentRunEvent["kind"]>(
  drive: EvalDrive,
  kind: K,
): Extract<AgentRunEvent, { kind: K }> | undefined =>
  drive.events.find((entry): entry is Extract<AgentRunEvent, { kind: K }> => entry.kind === kind);

describe("a refused capture records why it was refused", () => {
  test("postgres: the row budget refusal carries both numbers and no fabricated count", async () => {
    // The shape the provider raises when a read overruns its row budget (B52's
    // measurement): `queryReadOnly`
    // refuses rather than truncating, and the two numbers are the whole diagnosis —
    // 536 rows against a 200-row budget says "narrow the capture", where the reason
    // code alone says only "somebody said no".
    const run = await openEvalRun({
      engine: "postgres",
      mode: "planning",
      objective: "Which department has the most employees?",
      catalogAnswer: () => {
        throw new QueryError("Read-only execution exceeded the row budget: 536 rows > 200 allowed", "postgres");
      },
    });
    runs.push(run);

    const drive = await run.drive(PLAN);

    expect(drive.kinds).not.toContain("context-captured");
    expect(drive.kinds).toContain("context-unavailable");
    const event = eventOfKind(drive, "context-unavailable");
    expect(event).toMatchObject({
      reasonCode: "CATALOG_READ_REFUSED",
      rowBudget: { projected: 536, allowed: 200 },
    });
    // The absence rule, asserted rather than implied: nothing was read, so the entry
    // states no count and no fingerprint at all.
    expect(event).not.toHaveProperty("tableCount");
    expect(event).not.toHaveProperty("fingerprint");
    expect(drive.status).toBe("succeeded");
  });

  test("mysql: a provider that cannot describe itself records the reason and states no budget", async () => {
    // The other refusal family, and the reason `rowBudget` is optional rather than a
    // pair of zeros: this run met no budget, so a number here would be a measurement
    // nobody took.
    const run = await openPlan("mysql");

    const drive = await run.drive(PLAN);

    const event = eventOfKind(drive, "context-unavailable");
    expect(event?.reasonCode).toBe("CATALOG_READ_REFUSED");
    expect(event?.rowBudget).toBeUndefined();
    // The diagnosis the model was given, so the ledger and the prompt cannot disagree
    // about why this run had no inventory.
    expect(event?.detail).toContain("this database refused to describe its own schema");
  });

  test("postgres: a capture that SUCCEEDS records what it always did, and no refusal", async () => {
    // The control. `context-captured` is the entry every reader of a grounded run
    // depends on, and the fix above must not have moved any part of it.
    const run = await openPlan("postgres");

    const drive = await run.drive(PLAN);

    expect(drive.kinds).not.toContain("context-unavailable");
    const event = eventOfKind(drive, "context-captured");
    expect(event).toMatchObject({
      kind: "context-captured",
      tableCount: DEPARTMENTS.length,
      noun: { singular: "table", plural: "tables" },
    });
    expect(event?.fingerprint).toMatch(/^ctx_[0-9a-f]{32}$/);
    expect(event?.snapshot?.tables).toHaveLength(DEPARTMENTS.length);
  });
});

describe("a plan that names no statement is asked for one, whoever the model is", () => {
  /*
    `qwen3:14b`, plan, 4 of 5. Its losing run answered the objective completely — all eight
    tables, both join tables, the key every relation travels on — and never wrote the
    deliverable, so the verdict was `no-statement`. Planning had no notice for that: the prose
    arrived, `conclude` filed it as the closing statement, and the run was over.

    Who gets the turn is what these cases pin. A measured profile's number decides for the model
    it was written about — 0 means that model was watched declining the ask — and a model with no
    profile is asked once, because absence is not a measurement. So the drive is run through
    `modelOver`'s model name rather than the fixture default, and both sides are asserted.
  */
  const PROSE = "The department table holds dept_no and dept_name, and dept_emp joins it to employee.";
  const FENCED = "Here is the plan.\n\n```sql\nSELECT dept_no, COUNT(*) FROM dept_emp GROUP BY dept_no;\n```";

  /**
   * `driveModel` carries no transcripts of its own — `drive` fills them from the script it
   * built — so the scripted transport is returned beside the drive and the turns are read off
   * it. What the model was SENT is the whole assertion here, so it cannot be left out.
   */
  async function drivePlan(
    modelName: string,
    script: readonly ScriptedTurn[],
  ): Promise<{ drive: EvalDrive; sent: readonly string[] }> {
    const run = await openPlan("sqlite");
    const scripted = scriptedModel(...script);
    const drive = await run.driveModel(await modelOver(scripted.fetch, "https://api.openai.com/v1", modelName));
    return { drive, sent: scripted.turns.map((turn) => turn.transcript) };
  }

  test("qwen3:14b is told what a plan is scored on, and its second turn is what the run files", async () => {
    const { drive, sent } = await drivePlan("qwen3:14b", [answersProse(PROSE), answersProse(FENCED)]);

    // The notice offers BOTH endings. A notice asking only for SQL would push a model whose
    // inventory cannot answer into inventing a table name, which is the failure
    // `verifyPlanningGoal` accepts refusals to avoid.
    const told = sent[1] ?? "";
    expect(told).toContain("names no statement");
    expect(told).toContain("NO STATEMENT:");
    // And the run ends on the statement rather than on the prose that skipped it.
    expect(drive.kinds).toContain("plan-statement-drafted");
    expect(drive.status).toBe("succeeded");
  });

  test("a model nobody measured is asked too, because the ask is the server's own", async () => {
    /*
      This test asserted the opposite, and its reason was the per-model file's whole discipline:
      introducing a mechanism must change no run of any model but the one whose ledgers earned it.
      That restraint is right for a SETTING and wrong for this one. The ask fires only where
      `readPlanStatement` scores the closing prose `absent` — the same reader, with the same
      dialect, that `verifyPlanningGoal` is about to score `no-statement` on — so it is reachable
      only on a run already earning that verdict, and a run that clears the bar is never touched.
      What the old bound protected was not a passing run; it was silence on a losing one.

      `cogito:32b` and `qwen2.5:32b` are the measured cost: five surfaces each, plan 4/5, every
      loss `no-statement` with the model stopping on its own after prose that named the schema
      correctly. Neither has a row in the document, so neither was ever sent the sentence that
      won this cell for `ornith:9b` and `qwen3:14b`.
    */
    const { sent } = await drivePlan("gpt-4o-mini", [answersProse(PROSE), answersProse(FENCED)]);

    expect(sent.length).toBe(2);
    expect(sent[1] ?? "").toContain("names no statement");
  });

  test("qwen3:14b that refused instead of drafting is not asked again", async () => {
    // A refusal IS an ending plan mode scores, so asking for a statement after one would
    // spend a turn telling a passing run it had failed. Read with `readPlanStatement`, the
    // same reader the verifier uses, so the two cannot disagree about what a refusal is.
    const { sent } = await drivePlan("qwen3:14b", [
      answersProse("NO STATEMENT: this database records no budget, so the question cannot be answered from it."),
    ]);

    expect(sent.length).toBe(1);
  });
});
