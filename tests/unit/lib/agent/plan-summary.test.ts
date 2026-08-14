import { describe, expect, test } from "bun:test";
import { summarisePlan } from "@/lib/agent/plan-summary";

/**
 * The engine-neutral reading of an ESTIMATING plan (#330 T3).
 *
 * Two rules shape every case below, and both are about honesty rather than
 * convenience:
 *
 *  - **No engine text crosses into the summary.** A plan's own words carry table
 *    and index names, which are written by whoever can write to the database and
 *    are untrusted exactly like a row value. The summary is therefore structural —
 *    how the engine reaches the rows, and what it estimates — and the statement the
 *    model wrote is what names the objects, because the model already knows it.
 *  - **Nothing is invented for an engine that does not report it.** SQLite's query
 *    plan carries no cost and no row estimate at all, so this returns none. A zero
 *    would read as "free" and a guess would read as a measurement.
 */

const pgPlan = (node: Record<string, unknown>) => [{ "QUERY PLAN": [{ Plan: node }] }];

describe("PostgreSQL estimating plans", () => {
  test("a sequential scan is read as a full scan, with the engine's own estimates", () => {
    const summary = summarisePlan(
      "postgres-json",
      pgPlan({ "Node Type": "Seq Scan", "Total Cost": 210.5, "Plan Rows": 1000 }),
    );

    expect(summary).toEqual({ access: "full-scan", estimatedRows: 1000, estimatedCost: 210.5 });
  });

  test("an index scan is read as an index access", () => {
    const summary = summarisePlan(
      "postgres-json",
      pgPlan({ "Node Type": "Index Scan", "Total Cost": 8.3, "Plan Rows": 3 }),
    );

    expect(summary.access).toBe("index");
    expect(summary.estimatedRows).toBe(3);
  });

  test("an index-only scan and a bitmap index scan are index access too", () => {
    for (const nodeType of ["Index Only Scan", "Bitmap Index Scan"]) {
      expect(summarisePlan("postgres-json", pgPlan({ "Node Type": nodeType })).access, nodeType).toBe("index");
    }
  });

  test("a plan that scans one relation and indexes another is mixed", () => {
    const summary = summarisePlan(
      "postgres-json",
      pgPlan({
        "Node Type": "Hash Join",
        "Total Cost": 300,
        "Plan Rows": 50,
        Plans: [{ "Node Type": "Seq Scan" }, { "Node Type": "Index Scan" }],
      }),
    );

    expect(summary.access).toBe("mixed");
    // The ROOT's estimates, which are the whole plan's, not a child's.
    expect(summary.estimatedCost).toBe(300);
  });

  test("a plan whose nodes say nothing about access is unknown, not guessed", () => {
    expect(summarisePlan("postgres-json", pgPlan({ "Node Type": "Result" })).access).toBe("unknown");
  });

  test("a shape that is not a plan at all yields an unknown summary rather than throwing", () => {
    // The extractor is an unchecked cast upstream, so this layer has to survive
    // anything the engine or a driver produced.
    for (const rows of [[], [{ "QUERY PLAN": [] }], [{ "QUERY PLAN": "not a plan" }], [{ other: 1 }]]) {
      expect(summarisePlan("postgres-json", rows).access).toBe("unknown");
    }
  });

  test("a missing estimate is absent, never zero", () => {
    const summary = summarisePlan("postgres-json", pgPlan({ "Node Type": "Seq Scan" }));

    expect(summary.estimatedRows).toBeUndefined();
    expect(summary.estimatedCost).toBeUndefined();
  });
});

describe("SQLite query plans", () => {
  test("a SCAN row is a full scan", () => {
    const summary = summarisePlan("sqlite-queryplan", [{ id: 2, parent: 0, notused: 0, detail: "SCAN employee" }]);

    expect(summary).toEqual({ access: "full-scan" });
  });

  test("a SEARCH ... USING INDEX row is an index access", () => {
    const summary = summarisePlan("sqlite-queryplan", [
      { id: 2, parent: 0, notused: 0, detail: "SEARCH dept_emp USING INDEX idx_dept (dept_no=?)" },
    ]);

    expect(summary.access).toBe("index");
  });

  test("a covering index is still an index access", () => {
    const summary = summarisePlan("sqlite-queryplan", [
      { id: 2, parent: 0, notused: 0, detail: "SEARCH t USING COVERING INDEX idx (a=?)" },
    ]);

    expect(summary.access).toBe("index");
  });

  test("scanning one table and searching another by index is mixed", () => {
    const summary = summarisePlan("sqlite-queryplan", [
      { id: 2, parent: 0, notused: 0, detail: "SCAN employee" },
      { id: 4, parent: 0, notused: 0, detail: "SEARCH dept_emp USING INDEX idx_dept (dept_no=?)" },
    ]);

    expect(summary.access).toBe("mixed");
  });

  test("SQLite reports no cost and no row estimate, so the summary carries none", () => {
    // Fabricating one would contradict what the engine actually said.
    const summary = summarisePlan("sqlite-queryplan", [{ id: 2, parent: 0, notused: 0, detail: "SCAN employee" }]);

    expect(summary.estimatedRows).toBeUndefined();
    expect(summary.estimatedCost).toBeUndefined();
  });

  test("a plan of only temporary-structure notes says nothing about access", () => {
    const summary = summarisePlan("sqlite-queryplan", [
      { id: 2, parent: 0, notused: 0, detail: "USE TEMP B-TREE FOR ORDER BY" },
    ]);

    expect(summary.access).toBe("unknown");
  });

  test("rows that are not query-plan rows yield an unknown summary", () => {
    expect(summarisePlan("sqlite-queryplan", [{ nothing: true }]).access).toBe("unknown");
  });
});

/**
 * The step this reading did not weigh has to survive into the summary.
 *
 * Found by review on #373. `access` is a reading of the steps that WERE recognised, so
 * a plan of `SEARCH …` plus a step nothing here interprets reported `index` — an
 * unqualified "every relation is reached through an index" about a plan half of which
 * had not been read. The auto-execute gate takes `index` on SQLite as its entire
 * condition 2, so that plan was handed to the user's editor to run with no timeout on
 * the strength of a reading that had skipped a step.
 *
 * The signal is carried separately from `access` rather than folded into `unknown`,
 * because the two say different things and one consumer needs each: a comparison still
 * wants to know that the recognised steps were indexed, and only the gate refuses on
 * the part that was not read.
 */
describe("a SQLite step this reading cannot interpret is preserved, never silently dropped", () => {
  const step = (detail: string) => ({ id: 2, parent: 0, notused: 0, detail });

  test("a plan whose every step was read carries no uninterpreted signal at all", () => {
    expect(summarisePlan("sqlite-queryplan", [step("SEARCH t USING INDEX ix (a=?)")])).toEqual({ access: "index" });
    expect(summarisePlan("sqlite-queryplan", [step("SCAN employee")])).toEqual({ access: "full-scan" });
  });

  test("a sort beside an indexed seek is still an indexed access, and is flagged as not fully read", () => {
    const summary = summarisePlan("sqlite-queryplan", [
      step("SEARCH t USING INDEX ix (a=?)"),
      step("USE TEMP B-TREE FOR ORDER BY"),
    ]);

    expect(summary.access).toBe("index");
    expect(summary.uninterpretedStep).toBe(true);
  });

  test("a row carrying no detail at all is a step that was not read", () => {
    const summary = summarisePlan("sqlite-queryplan", [step("SCAN employee"), { id: 4, parent: 0, notused: 0 }]);

    expect(summary.access).toBe("full-scan");
    expect(summary.uninterpretedStep).toBe(true);
  });

  test("a plan of nothing but uninterpreted steps is unknown AND flagged", () => {
    const summary = summarisePlan("sqlite-queryplan", [step("USE TEMP B-TREE FOR ORDER BY")]);

    expect(summary).toEqual({ access: "unknown", uninterpretedStep: true });
  });

  test("PostgreSQL sets no such signal: its cost is weighed and its engine preempts", () => {
    // Deliberate, and argued in `auto-execute.ts` rather than assumed here. A PG plan
    // is full of nodes this reading does not tally — `Sort`, `Hash Join`, `Aggregate` —
    // none of which is a relation access, and flagging them would close the gate on
    // every plan the engine can produce while removing no hazard the numeric `Total
    // Cost` ceiling and the engine's own statement timeout do not already bound.
    const summary = summarisePlan(
      "postgres-json",
      pgPlan({ "Node Type": "Sort", "Total Cost": 12, Plans: [{ "Node Type": "Index Scan" }] }),
    );

    expect(summary.access).toBe("index");
    expect(summary.uninterpretedStep).toBeUndefined();
  });
});

describe("an engine with no verified reading", () => {
  test("is unknown rather than read by a rule nobody checked against it", () => {
    // Phase 1 is PostgreSQL and SQLite. A third engine's plan grammar has not been
    // verified, and reading it with either of these rules would be a claim about a
    // plan nobody has looked at.
    expect(summarisePlan("mysql-json", [{ anything: 1 }])).toEqual({ access: "unknown" });
    expect(summarisePlan(undefined, [{ anything: 1 }])).toEqual({ access: "unknown" });
  });
});

describe("SQLite's stable distinction is SEARCH versus SCAN, not the word INDEX", () => {
  // Found by review on #344. SQLite reports several indexed seeks that never say
  // "USING INDEX": a rowid lookup, a WITHOUT ROWID primary key, and the transient
  // index it builds itself. Reading only "USING [COVERING] INDEX" filed every one of
  // them as `unknown` — which is the summary saying it could not tell, about a plan
  // that had told it plainly.
  const step = (detail: string) => [{ id: 2, parent: 0, notused: 0, detail }];

  test.each([
    "SEARCH employee USING INTEGER PRIMARY KEY (rowid=?)",
    "SEARCH t USING AUTOMATIC COVERING INDEX (a=?)",
    "SEARCH t USING PRIMARY KEY (id=?)",
    "SEARCH t USING INDEX ix (a=?)",
    "SEARCH t USING COVERING INDEX ix (a=?)",
  ])("%s is an indexed access", (detail) => {
    expect(summarisePlan("sqlite-queryplan", step(detail)).access).toBe("index");
  });

  test("SCAN is still the only thing that reads a table whole", () => {
    expect(summarisePlan("sqlite-queryplan", step("SCAN employee")).access).toBe("full-scan");
  });

  test("a SEARCH beside a SCAN is still mixed", () => {
    expect(
      summarisePlan("sqlite-queryplan", [
        { id: 2, parent: 0, notused: 0, detail: "SCAN employee" },
        { id: 4, parent: 0, notused: 0, detail: "SEARCH dept USING INTEGER PRIMARY KEY (rowid=?)" },
      ]).access,
    ).toBe("mixed");
  });
});
