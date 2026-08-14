import { describe, expect, test } from "bun:test";
import {
  AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS,
  AGENT_AUTO_EXECUTE_MAX_PLAN_COST,
  type AgentAutoExecuteInput,
  evaluateAutoExecute,
} from "@/lib/agent/auto-execute";

/**
 * The gate is a pure function, and this is the whole of its contract: three
 * conditions, all of which must hold, and a named refusal when any one does not.
 *
 * Everything it needs is passed in. Obtaining the plan and reading the measurement
 * off the ledger belong to the caller — a gate that went looking for its own inputs
 * could not be enumerated over eight combinations the way this one is.
 */

const ANSWER = "SELECT region, sum(net_total) FROM sales GROUP BY 1 ORDER BY 2 DESC";

/** A passing case, which each test then breaks in exactly one place. */
function passing(): AgentAutoExecuteInput {
  return {
    sql: ANSWER,
    executedStatements: [ANSWER],
    elapsedMs: 120,
    plan: { format: "postgres-json", summary: { access: "index", estimatedRows: 40, estimatedCost: 900 } },
  };
}

describe("condition 1: the run executed this exact statement itself", () => {
  test("a statement the run executed passes", () => {
    expect(evaluateAutoExecute(passing())).toEqual({ handover: "auto-executed" });
  });

  test("a final statement wider than anything the run executed is never auto-executed", () => {
    const decision = evaluateAutoExecute({ ...passing(), executedStatements: ["SELECT region FROM sales LIMIT 10"] });

    expect(decision.handover).toBe("applied");
    expect(decision).toMatchObject({ condition: "not-executed" });
  });

  test("the match is on the text, not on a normalisation of it", () => {
    // Whitespace is not equivalence here on purpose: the statement handed over is the
    // one that ran, byte for byte, and a gate that folded two texts together would be
    // deciding that a statement it never saw is the statement it measured.
    const decision = evaluateAutoExecute({ ...passing(), executedStatements: [`${ANSWER} `] });

    expect(decision).toMatchObject({ condition: "not-executed" });
  });
});

describe("condition 2: the plan gate, per engine, with unknown resolving to risky", () => {
  test("PostgreSQL: an indexed plan under the cost threshold passes", () => {
    expect(evaluateAutoExecute(passing())).toEqual({ handover: "auto-executed" });
  });

  test("PostgreSQL: a mixed plan passes, because an index on one side is still not a full read", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "postgres-json", summary: { access: "mixed", estimatedCost: 900 } },
    });

    expect(decision).toEqual({ handover: "auto-executed" });
  });

  test("PostgreSQL: a full scan is risky whatever it costs", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "postgres-json", summary: { access: "full-scan", estimatedCost: 1 } },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("PostgreSQL: over the cost threshold is risky", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: {
        format: "postgres-json",
        summary: { access: "index", estimatedCost: AGENT_AUTO_EXECUTE_MAX_PLAN_COST + 1 },
      },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("PostgreSQL: exactly at the cost threshold passes, because the threshold is a ceiling", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "postgres-json", summary: { access: "index", estimatedCost: AGENT_AUTO_EXECUTE_MAX_PLAN_COST } },
    });

    expect(decision).toEqual({ handover: "auto-executed" });
  });

  test("PostgreSQL: a plan reporting no cost at all is risky, not free", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "postgres-json", summary: { access: "index" } },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("PostgreSQL: an access path this server could not interpret is risky", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "postgres-json", summary: { access: "unknown", estimatedCost: 1 } },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("SQLite: every step a SEARCH passes, with no cost anywhere in the plan", () => {
    // The engine reports neither a cost nor a row estimate, so requiring one here
    // would close the gate on SQLite permanently. What the plan does carry is the
    // access path, and that is what is read.
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "sqlite-queryplan", summary: { access: "index" } },
    });

    expect(decision).toEqual({ handover: "auto-executed" });
  });

  test("SQLite: any SCAN is risky, including one mixed with an index", () => {
    // Stricter than PostgreSQL's rule on purpose: this engine neither reports a cost
    // to weigh nor preempts a read that overruns, and a runaway read blocks writers
    // and this application until it finishes.
    for (const access of ["full-scan", "mixed", "unknown"] as const) {
      const decision = evaluateAutoExecute({
        ...passing(),
        plan: { format: "sqlite-queryplan", summary: { access } },
      });

      expect(decision).toMatchObject({ condition: "plan-risky" });
    }
  });

  test("SQLite: an indexed plan carrying a step the server could not interpret is risky", () => {
    // The fail-closed rule, at the level the reading actually failed at. `index` here
    // is a true statement about the steps that WERE read, and the plan also contained
    // one that was not — a sort, a temporary structure, something this build has never
    // seen. "Said nothing about that step" must not read as "said it was cheap", which
    // is the same sentence `unknown` is refused under one line above.
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "sqlite-queryplan", summary: { access: "index", uninterpretedStep: true } },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("SQLite: the same plan without that step is the one that passes", () => {
    // The pair matters: without this the test above would also pass against a gate
    // that had simply stopped auto-executing on SQLite entirely.
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "sqlite-queryplan", summary: { access: "index" } },
    });

    expect(decision).toEqual({ handover: "auto-executed" });
  });

  test("PostgreSQL: the same flag would refuse there too, though nothing sets it", () => {
    // The gate reads the signal before it reaches either engine's rule, so a reading
    // that starts reporting it for PostgreSQL is refused rather than newly admitted.
    // `summarisePlan` does not set it for that engine today, and `plan-summary.ts`
    // pins that with the reasoning.
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: {
        format: "postgres-json",
        summary: { access: "index", estimatedCost: 10, uninterpretedStep: true },
      },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("a dialect no one has verified is risky rather than read by another engine's rule", () => {
    const decision = evaluateAutoExecute({
      ...passing(),
      plan: { format: "mysql-json", summary: { access: "index", estimatedCost: 1 } },
    });

    expect(decision).toMatchObject({ condition: "plan-risky" });
  });

  test("no plan at all is risky: the gate never passes a statement it has no plan for", () => {
    const { plan: _plan, ...withoutPlan } = passing();

    expect(evaluateAutoExecute(withoutPlan)).toMatchObject({ condition: "plan-risky" });
  });
});

describe("condition 3: what the run actually measured", () => {
  test("over the elapsed threshold is applied, not run", () => {
    const decision = evaluateAutoExecute({ ...passing(), elapsedMs: AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS + 1 });

    expect(decision).toMatchObject({ condition: "measured-slow" });
    expect(decision.handover).toBe("applied");
  });

  test("exactly at the threshold passes", () => {
    const decision = evaluateAutoExecute({ ...passing(), elapsedMs: AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS });

    expect(decision).toEqual({ handover: "auto-executed" });
  });

  test("the warning names the measurement and the ceiling, in milliseconds", () => {
    const decision = evaluateAutoExecute({ ...passing(), elapsedMs: 8_000 });

    if (decision.handover !== "applied") throw new Error("expected the gate to decline");
    expect(decision.warning).toContain("8000 ms");
    expect(decision.warning).toContain(`${AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS} ms`);
  });
});

describe("the eight combinations", () => {
  /** One row of the truth table: which conditions hold, and what the gate answers. */
  const RISKY_PLAN = { format: "postgres-json", summary: { access: "full-scan" } } as const;

  function inputFor(executed: boolean, plan: boolean, quick: boolean): AgentAutoExecuteInput {
    return {
      sql: ANSWER,
      executedStatements: executed ? [ANSWER] : [],
      elapsedMs: quick ? 120 : 9_000,
      plan: plan ? passing().plan : RISKY_PLAN,
    };
  }

  test("all three holding is the only combination that is run", () => {
    const passes: boolean[] = [];
    for (const executed of [true, false]) {
      for (const plan of [true, false]) {
        for (const quick of [true, false]) {
          passes.push(evaluateAutoExecute(inputFor(executed, plan, quick)).handover === "auto-executed");
        }
      }
    }

    expect(passes.filter(Boolean)).toHaveLength(1);
    expect(passes[0]).toBe(true);
  });

  test("every other combination is applied, with the first failing condition named", () => {
    expect(evaluateAutoExecute(inputFor(false, false, false))).toMatchObject({
      handover: "applied",
      condition: "not-executed",
    });
    expect(evaluateAutoExecute(inputFor(true, false, false))).toMatchObject({ condition: "plan-risky" });
    expect(evaluateAutoExecute(inputFor(true, true, false))).toMatchObject({ condition: "measured-slow" });
    expect(evaluateAutoExecute(inputFor(false, true, true))).toMatchObject({ condition: "not-executed" });
    expect(evaluateAutoExecute(inputFor(false, false, true))).toMatchObject({ condition: "not-executed" });
    expect(evaluateAutoExecute(inputFor(false, true, false))).toMatchObject({ condition: "not-executed" });
    expect(evaluateAutoExecute(inputFor(true, false, true))).toMatchObject({ condition: "plan-risky" });
  });

  test("every refusal says why, in the register the app speaks in", () => {
    for (const executed of [true, false]) {
      for (const plan of [true, false]) {
        for (const quick of [true, false]) {
          const decision = evaluateAutoExecute(inputFor(executed, plan, quick));
          if (decision.handover === "auto-executed") continue;
          expect(decision.warning.startsWith("Not run for you:")).toBe(true);
          expect(decision.warning.endsWith("so this one is yours to run.")).toBe(true);
        }
      }
    }
  });
});
