import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type EvalEngine, type EvalRun, openEvalRun } from "../isolated/fixtures/agent-eval-harness";
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

const reads = (kind: string, extra: Record<string, unknown> = {}) =>
  callsTool("inspect_operations", { kind, ...extra }, `call_${kind}`);

const operationsArc = [reads("sessions"), reportOn("One session has been blocked on a lock for over four minutes.")];

describe("the operations arc, on every engine including one agent mode otherwise refuses", () => {
  for (const engine of ["postgres", "sqlite", "mysql"] as const) {
    test(`${engine}: takes a reading, settles it as an artifact, and answers`, async () => {
      const run = await open(engine);

      const drive = await run.drive(operationsArc);

      // No `context-captured` on ANY engine: an operations run captures no schema
      // inventory, deliberately, because it has no tool that could read one and most
      // of the engines it runs on cannot serve one at all.
      expect(drive.kinds).toEqual(["run-started", "tool-invoked", "tool-completed", "report-composed", "run-finished"]);
      expect(drive.verdict).toEqual({ outcome: "answered", verifier: "agent-operations.1", unmet: [] });
    });

    test(`${engine}: the run sends NO statement to the database at all`, async () => {
      // The property the whole workflow rests on. Asserted over the statements that
      // reached the engine rather than over the tool set, because a tool added to
      // this workflow later would pass a tool-set assertion and fail this one.
      const run = await open(engine);

      const drive = await run.drive(operationsArc);

      expect(drive.statements).toEqual([]);
      expect(drive.modelStatements).toEqual([]);
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

  test("the model is told, before its first turn, that it has no schema and no SQL", async () => {
    const run = await open("mysql");

    const drive = await run.drive([answersProse("Nothing to add.")]);

    expect(drive.transcripts[0]).toContain("No schema inventory was captured for this run");
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
