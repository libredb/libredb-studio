import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { DEPARTMENTS, type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
import { type Turn, answersProse, callsTool, reportOn } from "../isolated/fixtures/agent-scripted-model";
import { QueryError } from "@/lib/db/errors";

/**
 * The `operations` template, driven end to end — including on an engine the rest of
 * agent mode is refused on.
 *
 * The invariant asserted hardest here is not the arc but the reason the workflow
 * exists: **it reaches a database that offers no read-only statement path, and it
 * sends no statement to get there.** Both halves are checked against what the run
 * actually did, not against what its tools intend — and the MySQL preset carries no
 * `queryReadOnly` at all, exactly as the real provider does not, so a run that sent a
 * statement dies on the fixture rather than being quietly answered by PostgreSQL's
 * default row.
 */

const runs: EvalRun[] = [];
let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  // Every run below opens on the same connection id, and an operations run both fills
  // the process-held inventory and reads it (#411). Without this the SQLite run would
  // be handed the PostgreSQL run's tables, and the grounding assertions would be about
  // the previous test rather than about this one.
  forgetHeldSnapshots();
});

afterEach(() => {
  consoleSpy.mockRestore();
  for (const run of runs.splice(0)) run.dispose();
});

async function open(engine: EvalEngine, curated?: Partial<Record<string, unknown>>): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    workflowType: "operations",
    objective: "What is this database spending its time on right now, and what is blocked?",
    ...(curated === undefined ? {} : { curated }),
  });
  runs.push(run);
  return run;
}

/** The same objective, planned rather than run: no tools at all, and no readings. */
async function openPlan(engine: EvalEngine): Promise<EvalRun> {
  const run = await openEvalRun({
    engine,
    mode: "planning",
    workflowType: "operations",
    objective: "What is this database spending its time on right now, and what is blocked?",
  });
  runs.push(run);
  return run;
}

const reads = (kind: string, extra: Record<string, unknown> = {}) =>
  callsTool("inspect_operations", { kind, ...extra }, `call_${kind}`);

const operationsArc = [reads("sessions"), reportOn("One session has been blocked on a lock for over four minutes.")];

describe("the operations arc, on every engine including one agent mode otherwise refuses", () => {
  for (const engine of ["postgres", "sqlite", "mysql"] as const) {
    test(`${engine}: takes a reading, settles it as an artifact, and answers`, async () => {
      const run = await open(engine);

      const drive = await run.drive(operationsArc);

      // `context-captured` appears exactly where a catalog can be read (#411): the two
      // engines `CATALOG_PLANS` serves ground the run before its first turn, and every
      // other engine continues ungrounded rather than failing.
      const grounded = engine === "mysql" ? [] : ["context-captured"];
      expect(drive.kinds).toEqual([
        "run-started",
        ...grounded,
        "tool-invoked",
        "tool-completed",
        "report-composed",
        "run-finished",
      ]);
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-operations.2", unmet: [] });
    });

    test(`${engine}: the MODEL sends no statement to the database at all`, async () => {
      // The property the whole workflow rests on, and #411 narrowed it rather than
      // removing it: the SERVER may read this connection's catalog before the first
      // turn, and the model still has no tool that sends SQL. Asserted over the
      // statements that reached the engine rather than over the tool set, because a
      // tool added to this workflow later would pass a tool-set assertion and fail
      // this one.
      const run = await open(engine);

      const drive = await run.drive(operationsArc);

      expect(drive.modelStatements).toEqual([]);
      // And the server's own reads are the grounding reads and nothing else: on MySQL
      // there are none at all, because the capture refuses the dialect before it
      // acquires a provider.
      expect(drive.statements.length).toBe(run.engine.catalogReads.length);
    });
  }
});

/**
 * #411: the workflow that used to be handed nothing.
 *
 * The premise the exclusion rested on — "an operations objective is not about the
 * schema" — is true about the QUESTION and false about the evidence. Every reading
 * this run can take comes back full of schema identifiers: a lock is held on a
 * relation, an index-stats row names an index, a slow query names tables. A run that
 * has never seen the inventory reads those as opaque strings.
 *
 * What is asserted here is what the run is HANDED and what it is TOLD, together. The
 * two agreeing is the point: a grounded run told it has no inventory would reason as
 * though it had none, and an ungrounded run told it has one is the false
 * self-description this repository keeps finding.
 */
describe("an operations run is grounded in the objects its readings will name (#411)", () => {
  for (const engine of ["postgres", "sqlite"] as const) {
    test(`${engine}: agent mode is handed a fenced inventory of names and indexes, and no relations graph`, async () => {
      const run = await open(engine);

      const drive = await run.drive([answersProse("Nothing to add.")]);

      const first = drive.transcripts[0] ?? "";
      expect(drive.kinds).toContain("context-captured");
      for (const table of DEPARTMENTS) expect(first).toContain(table);
      // Database content, so it arrives fenced exactly as every other workflow's
      // inventory does: a table name is writable by whoever can write to the database.
      expect(first).toContain("BEGIN UNTRUSTED");
      expect(first).toContain("Names and the indexes on each");
      // The exact shape, per engine, so the assertion below cannot pass by rendering
      // something else entirely — and quoted, because the identifier list is what the
      // run is told to match the engine's own reports against.
      expect(first).toContain(engine === "postgres" ? '\\"public.engineering\\"' : '\\"engineering\\"');
      // The two parts this workflow deliberately does not get. The relations graph is
      // its own fenced block with its own label, and the columns would arrive through
      // `renderTable`, whose separator is `; indexes:` where this renderer writes
      // `: indexes `. Asserted on the separator rather than on a type name: `INTEGER`
      // arrives uppercase from SQLite's own DDL, so `not.toContain("integer")` pinned
      // nothing on half the engines (review, #411).
      expect(first).not.toContain("schema relations");
      expect(first).not.toContain("; indexes:");
      expect(drive.modelStatements).toEqual([]);
    });

    test(`${engine}: the run's own rules say an inventory was captured where the engine can be read`, async () => {
      // `WORKFLOW_TOOL_RULES.operations` opened with "and no schema inventory was
      // captured for you" until #411, which captures one. The rules are the same string
      // for every run of the workflow while the grounding is not, so they hedge on the
      // engine and the per-run truth lives in the opening note — and nothing pinned
      // either half of that sentence, so the false one could have survived the change
      // with every gate green (review, #411).
      const run = await open(engine);

      const drive = await run.drive([answersProse("Nothing to add.")]);

      const rules = drive.transcripts[0] ?? "";
      expect(rules).toContain("Where this engine can be read, a schema inventory of table names and their indexes");
      expect(rules).not.toContain("no schema inventory was captured for you");
      // Still the workflow's defining constraint, and still stated first.
      expect(rules).toContain("You have NO SQL in this run");
    });

    test(`${engine}: the note says it HAS an inventory, and never that none was needed`, async () => {
      const run = await open(engine);

      const drive = await run.drive([answersProse("Nothing to add.")]);

      const first = drive.transcripts[0] ?? "";
      expect(first).toContain("A schema inventory was read for this run before your first turn");
      // The sentence this change makes false, in either of its two spellings.
      expect(first).not.toContain("and none is needed");
      expect(first).not.toContain("No schema inventory could be read");
      // Still true, and still the reason the workflow exists: it holds no SQL tool.
      expect(first).toContain("inspect_operations");
      expect(first).toContain("no tool here that sends SQL");
    });

    test(`${engine}: an operations PLAN is handed the inventory AND the estimated statistics`, async () => {
      // A plan run can read nothing, ever, so the engine's own estimates are the only
      // sizes it will have. It gets them because plan mode already reads them for
      // every workflow — the asymmetry with agent mode falls out of that rather than
      // being branched on here.
      const run = await openPlan(engine);

      const drive = await run.drive([answersProse("I would read the wait events on engineering.")]);

      const first = drive.transcripts[0] ?? "";
      for (const table of DEPARTMENTS) expect(first).toContain(table);
      expect(first).toContain("Names and the indexes on each");
      expect(first).toContain("roughly 41 row(s), estimated");
      expect(first).toContain("no row estimate recorded; its size is unknown");
      // Sizes and nothing per column. The default rendering names a column beside every
      // table it has an estimate for, which would leak a column name into the one
      // workflow whose whole context is identifiers of two kinds — and would contradict
      // the sentence above it in the same conversation (review, #411).
      expect(first).not.toContain("distinct value(s)");
      expect(first).not.toContain("null, estimated");
      // Grounded, and told so: the plan rules key on that flag, and they ask for the
      // real objects rather than for readings in the abstract.
      expect(first).toContain("A schema inventory for this database is in this conversation");
      expect(first).toContain("Name the real tables and indexes each reading would be about");
      expect(first).not.toContain("No schema inventory is available to this run");
      // Its deliverable is unchanged: prose, and no statement contract. What it is NOT
      // is a prohibition on fencing one — an operational reading on these two engines is
      // very often an ordinary SELECT over the engine's own reporting views, and a run
      // driven in a browser on 2026-08-17 fenced `pg_stat_user_indexes` and was offered
      // "Apply to editor" while its rules said there was no block to produce.
      expect(first).not.toContain("There is no statement to write here");
      expect(first).not.toContain("no fenced block to produce");
      expect(first).toContain("A reading is not always prose");
      expect(first).toContain("READ WHAT THE ENGINE REPORTS ABOUT ITSELF");
      expect(first).not.toContain("Produce ONE runnable statement");
      // And still no tool is named, in a mode that has none (#350).
      expect(first).not.toContain("inspect_operations");
      expect(first).not.toContain("inspect_schema");
      expect(drive.modelStatements).toEqual([]);
      expect(drive.status).toBe("succeeded");
    });
  }

  for (const mode of ["agent", "planning"] as const) {
    test(`mysql: a ${mode} run this server cannot ground is told so, and is not told it has an inventory`, async () => {
      // `CATALOG_PLANS` serves PostgreSQL and SQLite; since #414 every other dialect
      // asks its PROVIDER for the same inventory instead of refusing on the dialect.
      // This preset's provider carries only the curated readings — exactly as it did
      // before, and exactly as an engine whose provider cannot describe itself would
      // — so the capture is refused and the run continues ungrounded, which is why
      // this workflow still reaches MySQL, MongoDB and Redis at all.
      const run = mode === "agent" ? await open("mysql") : await openPlan("mysql");

      const drive = await run.drive([answersProse("Nothing to add.")]);

      const first = drive.transcripts[0] ?? "";
      // The capture's own diagnosis, which is the only thing that knows WHY — here a
      // provider that serves no such reading, elsewhere a refusal or a released
      // result. Substituting a sentence of the caller's own threw that away (review,
      // #411). Until #414 the diagnosis here named the DIALECT ("no schema inventory
      // can be read for a mysql connection"), which was the true reason then and is
      // no longer: the dialect no longer decides it. Here it is a `getSchema()` that
      // rejected, and the engine's own words reach the model fenced.
      expect(first).toContain("this database refused to describe its own schema");
      expect(first).not.toContain("A schema inventory was read for this run");
      // Nothing was shown to it either, so there is nothing to mistake for an
      // inventory it does not have.
      expect(first).not.toContain("table(s) read at epoch");
      expect(first).not.toContain("and none is needed");
      // Never the capture's own fallback, which sends a model to `inspect_schema`: no
      // operations run has one, in either mode (#350). The agent rules name that tool
      // to say the run does NOT hold it, which is why this looks for the advice rather
      // than for the word.
      expect(first).not.toContain("Use inspect_schema");
      expect(first).not.toContain("before drafting a statement");
      expect(drive.statements).toEqual([]);
      expect(drive.kinds).not.toContain("context-captured");
    });
  }
});

describe("what a reading is, once it has settled", () => {
  test("it is an ordinary artifact: cited by the report, and charged to the budget", async () => {
    // The same three consumers `table-profiled` had to satisfy — the citation check,
    // the artifact route and the rail's budget fold — all read `tool-completed` and
    // nothing else, so a curated reach that skipped the step would be uncitable,
    // unshowable and uncounted.
    const run = await open("mysql");

    const drive = await run.drive(operationsArc);

    const settled = drive.events.find((event) => event.kind === "tool-completed");
    if (settled?.kind !== "tool-completed") throw new Error("expected a settlement");
    expect(settled.artifact.operationId).toBe("db.operations.read");
    expect(settled.artifact.summary.rowCount).toBe(1);
    expect(settled.artifact.summary.columnNames).toContain("blocked");

    const report = drive.events.find((event) => event.kind === "report-composed");
    if (report?.kind !== "report-composed") throw new Error("expected a report");
    expect(report.claims[0]?.evidence[0]).toEqual({
      source: "artifact",
      correlationId: settled.artifact.correlationId,
    });
  });

  test("the session's own text reaches the model FENCED, because a database wrote it", async () => {
    // `ActiveSessionDetails.query` and `.user` are a statement somebody wrote and an
    // identity. Both are database content and neither may reach a prompt unfenced.
    const run = await open("mysql");

    const drive = await run.drive(operationsArc);

    const transcript = drive.transcripts[1] ?? "";
    expect(transcript).toContain("UPDATE orders SET total = 1 WHERE id = 9");
    const fenced = transcript.indexOf("BEGIN UNTRUSTED");
    expect(fenced).toBeGreaterThanOrEqual(0);
    expect(transcript.indexOf("UPDATE orders SET total = 1")).toBeGreaterThan(fenced);
  });

  test("the model is told, before its first turn, that it has no SQL", async () => {
    const run = await open("mysql");

    const drive = await run.drive([answersProse("Nothing to add.")]);

    expect(drive.transcripts[0]).toContain("no tool here that sends SQL");
    expect(drive.transcripts[0]).toContain("inspect_operations");
    // And never the advice the other workflows get, which names a tool this run does
    // not have — the #350 failure mode this branch exists to avoid.
    expect(drive.transcripts[0]).not.toContain("before drafting a statement");
  });
});

describe("an engine that cannot serve a reading", () => {
  test("is refused rather than crashing the run, and the refusal is on the ledger", async () => {
    // The pinned promise: some engines have no concept of some of these readings, and
    // the run is told so and carries on rather than dying. The engine's own words
    // reach the model, and they reach it fenced.
    const run = await open("mysql", {
      getSlowQueries: async () => {
        throw new QueryError("performance_schema is not enabled", "mysql");
      },
    });

    const drive = await run.drive([
      reads("slow-queries"),
      (turn: Turn) => {
        expect(turn.transcript).toContain("performance_schema is not enabled");
        return answersProse("This server keeps no slow-query statistics.")(turn);
      },
    ]);

    expect(drive.kinds).toEqual(["run-started", "tool-invoked", "tool-refused", "closing-statement", "run-finished"]);
    expect(drive.status).toBe("succeeded");
    // Nothing was cited, so the run is honestly recorded as not having answered —
    // the workflow's bar is a cited reading, and it took none.
    expect(drive.verdict.unmet).toEqual(["no-report"]);
  });

  test("a DRIVER-native error is refused too, not just a mapped DatabaseError", async () => {
    // The engine-specific half of the same promise, and the one a `QueryError`
    // fixture cannot show. MongoDB's `getTableStats` calls `listCollections()`
    // outside any try/catch, so a `MongoServerError` reaches the tool layer raw —
    // and an unrouted throw there ends the whole run `failed`/`internal` with no
    // report, on exactly the engines this workflow exists to reach.
    class MongoServerError extends Error {}
    const run = await open("mysql", {
      getTableStats: async () => {
        throw new MongoServerError("not authorized on company to execute command listCollections");
      },
    });

    const drive = await run.drive([
      reads("table-stats"),
      (turn: Turn) => {
        expect(turn.transcript).toContain("not authorized on company");
        return reads("sessions")(turn);
      },
      reportOn("One session has been blocked on a lock for over four minutes."),
    ]);

    expect(drive.status).toBe("succeeded");
    expect(drive.kinds).toContain("tool-refused");
    expect(drive.verdict.outcome).toBe("answered");
  });

  test("a RESUMED run is told the reading was taken and not delivered, not that nothing happened", async () => {
    // The ledger-honesty arm. A refused reading is a settlement, so a run resumed
    // after one is told what actually happened: the call reached the database, spent
    // a statement of the run's budget, and its answer was not delivered. A run-loop
    // outcome would have left the step unsettled and the resumed run would be told
    // its outcome cannot be known — about a call the audit stream records.
    const run = await open("mysql", { getStorageStats: undefined });

    await expect(run.drive([reads("storage")])).rejects.toThrow(/died before turn/);

    const resumed = await run.drive([answersProse("This engine reports no storage figures.")]);

    const firstTurn = resumed.transcripts[0] ?? "";
    expect(firstTurn).toContain("reached the database and its reading was not delivered");
    expect(firstTurn).toContain("KIND_UNSUPPORTED_BY_PROVIDER");
  });

  test("an unavailable reading leaves the run able to try a different kind", async () => {
    const run = await open("mysql", { getStorageStats: undefined });

    const drive = await run.drive([
      reads("storage"),
      (turn: Turn) => {
        expect(turn.transcript).toContain("serves no reading of that kind");
        return reads("sessions")(turn);
      },
      reportOn("One session has been blocked on a lock for over four minutes."),
    ]);

    expect(drive.verdict.outcome).toBe("answered");
    expect(drive.statements).toEqual([]);
  });
});
