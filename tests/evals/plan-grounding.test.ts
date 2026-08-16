import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { DEPARTMENTS, type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { answersProse } from "../isolated/fixtures/agent-scripted-model";

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

const PLAN = [answersProse("I would read the engineering table and count its rows.")];

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
    // The honest limit of item 6: grounding is served for the dialects
    // `CATALOG_COMPOSERS` covers, and MySQL is not one of them. The MySQL preset
    // carries no `queryReadOnly` at all, exactly as the real provider does not, so a
    // run that tried to read a catalog here would die on the fixture.
    const run = await openPlan("mysql");

    const drive = await run.drive(PLAN);

    expect(drive.statements).toEqual([]);
    expect(drive.kinds).not.toContain("context-captured");
    const sent = drive.transcripts[0] ?? "";
    expect(sent).toContain("on this mysql connection");
    expect(sent).toContain("No schema inventory is available to this run");
    // Never in the capture's own words, which send a model to `inspect_schema`: a
    // planning run has no tools, and naming one it does not have is the #350 failure.
    expect(sent).not.toContain("inspect_schema");
    expect(drive.status).toBe("succeeded");
  });
});
