import { describe, expect, test } from "bun:test";
import {
  AGENT_EXECUTION_PROFILE,
  AGENT_HANDOVER_BUDGET,
  AGENT_HANDOVER_PROFILE,
  AGENT_MAX_REPAIR_ATTEMPTS,
  AGENT_MINIMUM_CALL_MS,
  AGENT_MODEL_TURN_TIMEOUT_MS,
  AGENT_REPORT_RESERVE_MS,
  AGENT_REPORT_RESERVE_TURNS,
  AGENT_WORKFLOW_BUDGETS,
} from "@/lib/agent/execution-policy";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import type { ExecutionActor, ExecutionPolicy, OperationRequest } from "@/lib/db/operations/policy";
import { createTargetScope, evaluateOperation } from "@/lib/db/operations/policy";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * The agent programme's own per-workflow `ExecutionPolicy` records (#329 T6, and the
 * per-workflow ceilings the data-analyst design froze).
 *
 * The point of these assertions is that the constants are checked against the REAL
 * pipeline rather than against a restatement of it: `isValidPolicy` is private to
 * `policy.ts`, so the only honest way to prove a constant is enforceable is to run a
 * decision through `evaluateOperation` and see that it is not refused with
 * `MALFORMED_POLICY_CONTEXT`. Every workflow's policy is run through it, because a
 * fourth row added later is a policy nothing has ever enforced.
 */

const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

const scope = createTargetScope("conn-1");
const tracker = new ExecutionBudgetTracker();

function decide(policy: ExecutionPolicy, request: OperationRequest, actor: ExecutionActor) {
  return evaluateOperation({
    registry: createCanonicalOperationRegistry(),
    policy,
    actor,
    scope,
    request,
    capabilities,
    usage: tracker.usage("run-unused"),
  });
}

const readRequest: OperationRequest = {
  operationId: "sql.query.read",
  target: {},
  input: { sql: "SELECT id FROM orders" },
};

const workflowTypes = Object.keys(AGENT_WORKFLOW_BUDGETS) as AgentRunWorkflowType[];

/**
 * The figures the owner approved on 2026-08-14, restated here so a silent edit to the
 * constants fails rather than being ratified by a test that reads them back. Four
 * rows come from the decision table; `operations` is the fifth, decided in this
 * repository because it landed after the design was written.
 */
const DECIDED: Readonly<
  Record<
    AgentRunWorkflowType,
    { turns: number; statements: number; runDeadlineMs: number; databaseMs: number; version: string }
  >
> = {
  investigation: {
    turns: 36,
    statements: 30,
    runDeadlineMs: 450_000,
    databaseMs: 90_000,
    version: "agent-read-only.investigation.1",
  },
  "query-optimization": {
    turns: 36,
    statements: 30,
    runDeadlineMs: 450_000,
    databaseMs: 90_000,
    version: "agent-read-only.query-optimization.1",
  },
  "database-assessment": {
    turns: 48,
    statements: 45,
    runDeadlineMs: 630_000,
    databaseMs: 135_000,
    version: "agent-read-only.database-assessment.1",
  },
  operations: {
    turns: 20,
    statements: 12,
    runDeadlineMs: 300_000,
    databaseMs: 60_000,
    version: "agent-read-only.operations.1",
  },
  "data-analysis": {
    turns: 60,
    statements: 42,
    runDeadlineMs: 900_000,
    databaseMs: 180_000,
    version: "agent-read-only.data-analysis.1",
  },
};

describe("AGENT_WORKFLOW_BUDGETS — accepted by the real pipeline", () => {
  test.each(workflowTypes)("%s: a bounded read by an admin is allowed, so the policy is not malformed", (workflow) => {
    const { policy } = AGENT_WORKFLOW_BUDGETS[workflow];
    const decision = decide(policy, readRequest, { sessionId: "s-1", role: "admin", mode: "agent" });

    expect(decision.kind).toBe("allow");
    expect(decision.policyVersion).toBe(policy.version);
  });

  test("a bounded read by a plain user is allowed — only /admin is role-gated in this product", () => {
    const decision = decide(AGENT_WORKFLOW_BUDGETS.investigation.policy, readRequest, {
      sessionId: "s-1",
      role: "user",
      mode: "agent",
    });

    expect(decision.kind).toBe("allow");
  });

  test("the estimating plan inspection is allowed without approval", () => {
    const decision = decide(
      AGENT_WORKFLOW_BUDGETS.investigation.policy,
      { operationId: "sql.explain.estimate", target: {}, input: { sql: "SELECT id FROM orders" } },
      { sessionId: "s-1", role: "user", mode: "agent" },
    );

    expect(decision.kind).toBe("allow");
  });

  test("the executing plan variant can only ever reach require-approval under every policy", () => {
    for (const workflow of workflowTypes) {
      const decision = decide(
        AGENT_WORKFLOW_BUDGETS[workflow].policy,
        { operationId: "sql.explain.analyze", target: {}, input: { sql: "EXPLAIN ANALYZE SELECT id FROM orders" } },
        { sessionId: "s-1", role: "admin", mode: "agent" },
      );

      expect(decision.kind, workflow).toBe("require-approval");
    }
  });
});

describe("AGENT_WORKFLOW_BUDGETS — the frozen decision table", () => {
  test.each(workflowTypes)("%s carries the approved figures and nothing else", (workflow) => {
    const budget = AGENT_WORKFLOW_BUDGETS[workflow];
    const decided = DECIDED[workflow];

    expect(budget.maxModelTurns).toBe(decided.turns);
    expect(budget.policy.budgets.maxStatementsPerRun).toBe(decided.statements);
    expect(budget.runDeadlineMs).toBe(decided.runDeadlineMs);
    expect(budget.policy.budgets.maxTotalRunMs).toBe(decided.databaseMs);
    expect(budget.policy.version).toBe(decided.version);
  });

  test("the record is total over the workflow union, so a new workflow cannot inherit a budget", () => {
    const expected: AgentRunWorkflowType[] = [
      "investigation",
      "query-optimization",
      "database-assessment",
      "operations",
      "data-analysis",
    ];
    expect([...workflowTypes].sort()).toEqual([...expected].sort());
  });

  /**
   * The version is what reaches a recorded policy decision, so two workflows sharing
   * one would make a deny code untraceable to the ceiling that produced it — which is
   * the entire reason the field exists.
   */
  test("every workflow's policy version is distinct, and names the workflow it belongs to", () => {
    const versions = workflowTypes.map((workflow) => AGENT_WORKFLOW_BUDGETS[workflow].policy.version);

    expect(new Set(versions).size).toBe(versions.length);
    for (const workflow of workflowTypes) {
      expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.version).toMatch(
        new RegExp(`^agent-read-only\\.${workflow}\\.\\d+$`),
      );
    }
  });

  /**
   * Shared identity would be the quiet way two rows come to mean one ceiling: a
   * literal reused for two workflows reads as a decision and is an accident, and the
   * day one of them moves the other moves with it.
   */
  test("no two workflows share a budgets object, a policy object or a budget row", () => {
    const budgets = workflowTypes.map((workflow) => AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets);
    const policies = workflowTypes.map((workflow) => AGENT_WORKFLOW_BUDGETS[workflow].policy);
    const rows = workflowTypes.map((workflow) => AGENT_WORKFLOW_BUDGETS[workflow]);

    expect(new Set(budgets).size).toBe(budgets.length);
    expect(new Set(policies).size).toBe(policies.length);
    expect(new Set(rows).size).toBe(rows.length);
  });
});

describe("AGENT_WORKFLOW_BUDGETS — shape", () => {
  test.each(workflowTypes)("%s admits risk class 1, which is what a bounded data read is", (workflow) => {
    expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.maxRiskClass).toBe(1);
  });

  test.each(workflowTypes)("%s admits only the agent mode — the editor path is not policed here", (workflow) => {
    expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.allowedModes).toEqual(["agent"]);
  });

  test.each(workflowTypes)("%s admits both roles, matching the product's authorization model", (workflow) => {
    expect([...AGENT_WORKFLOW_BUDGETS[workflow].policy.allowedRoles].sort()).toEqual(["admin", "user"]);
  });

  test.each(workflowTypes)("%s: every budget dimension is a positive whole number", (workflow) => {
    const budget = AGENT_WORKFLOW_BUDGETS[workflow];
    for (const [field, value] of Object.entries(budget.policy.budgets)) {
      expect(Number.isInteger(value), `${field} must be an integer, got ${String(value)}`).toBe(true);
      expect(value, `${field} must be >= 1`).toBeGreaterThanOrEqual(1);
    }
    expect(Number.isInteger(budget.runDeadlineMs)).toBe(true);
    expect(Number.isInteger(budget.maxModelTurns)).toBe(true);
    expect(budget.maxModelTurns).toBeGreaterThanOrEqual(1);
  });

  test.each(workflowTypes)("%s is frozen all the way down, so no caller can widen it in place", (workflow) => {
    const budget = AGENT_WORKFLOW_BUDGETS[workflow];
    expect(Object.isFrozen(AGENT_WORKFLOW_BUDGETS)).toBe(true);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(Object.isFrozen(budget.policy)).toBe(true);
    expect(Object.isFrozen(budget.policy.budgets)).toBe(true);
    expect(Object.isFrozen(budget.policy.allowedRoles)).toBe(true);
    expect(Object.isFrozen(budget.policy.allowedModes)).toBe(true);
  });

  test.each(workflowTypes)("%s: a result fits a prompt — the caps are model-sized, not editor-sized", (workflow) => {
    expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.maxResultRows).toBeLessThanOrEqual(500);
    expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.maxResultBytes).toBeLessThanOrEqual(512 * 1024);
  });

  test.each(workflowTypes)("%s runs one statement at a time: the loop is sequential", (workflow) => {
    expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.maxConcurrentExecutions).toBe(1);
  });

  test.each(workflowTypes)("%s: the wall clock is larger than the database time it sits outside of", (workflow) => {
    const budget = AGENT_WORKFLOW_BUDGETS[workflow];
    expect(budget.runDeadlineMs).toBeGreaterThan(budget.policy.budgets.maxTotalRunMs);
  });

  /**
   * A deadline below the per-call ceiling would make the run's own reason unreachable
   * on the very first turn: `investigation.ts` reports `model-timeout` only when the
   * call's bound is the smaller of the two.
   */
  test.each(workflowTypes)("%s leaves room for more than one model call at the per-call ceiling", (workflow) => {
    expect(AGENT_WORKFLOW_BUDGETS[workflow].runDeadlineMs).toBeGreaterThan(AGENT_MODEL_TURN_TIMEOUT_MS * 2);
  });
});

describe("the run-level constants the tool layer and the run service share", () => {
  test("the execution profile is the agent read-only one, never the shared writable path", () => {
    expect(AGENT_EXECUTION_PROFILE).toBe("agent-read-only");
  });

  test("the minimum viable call fits under every statement ceiling, so admit can never throw on it", () => {
    expect(AGENT_MINIMUM_CALL_MS).toBeGreaterThanOrEqual(1);
    for (const workflow of workflowTypes) {
      expect(AGENT_MINIMUM_CALL_MS, workflow).toBeLessThanOrEqual(
        AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.statementTimeoutMs,
      );
    }
  });

  test("the repair budget is the three attempts the milestone pinned", () => {
    expect(AGENT_MAX_REPAIR_ATTEMPTS).toBe(3);
  });
});

/**
 * The editor hand-over's own budget (#373 review).
 *
 * The replay is what the auto-execute checkbox buys, and until this review it ran on
 * the editor's read-WRITE route with no engine boundary at all. It now runs through
 * `queryReadOnly` under its own profile, and this budget is what the checkbox's copy
 * promises: the editor's row limit, and no statement timeout.
 */
describe("the budget the editor hand-over is replayed under", () => {
  test("it is a distinct profile, and the agent's own is not widened to serve it", () => {
    // The two bound different things — what a MODEL may spend on a run, and what a
    // USER's replay may spend — so a shared row would have made a change to one move
    // the other. Asserted as the pair, because the point is that they differ.
    expect(AGENT_HANDOVER_PROFILE).toBe("agent-handover");
    expect(AGENT_HANDOVER_PROFILE).not.toBe(AGENT_EXECUTION_PROFILE);
    for (const workflow of workflowTypes) {
      expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.statementTimeoutMs, workflow).toBe(10_000);
      expect(AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.maxResultRows, workflow).toBe(200);
    }
  });

  test("the row limit is the editor's own default, so the copy and the enforcement are one number", () => {
    expect(AGENT_HANDOVER_BUDGET.maxResultRows).toBe(DEFAULT_QUERY_LIMIT);
  });

  test('"no time limit" is the largest value the read-only check admits, and not one more', () => {
    // The plumbing cannot express an absent timeout: PostgreSQL interpolates it into
    // `SET LOCAL statement_timeout = N`, so `assertReadOnlyBudget` demands a positive
    // integer. This pins that the constant is that ceiling by PROBING the check rather
    // than by restating its number, so the two cannot drift apart.
    expect(() => assertReadOnlyBudget(AGENT_HANDOVER_BUDGET, "postgres")).not.toThrow();
    expect(() =>
      assertReadOnlyBudget(
        { ...AGENT_HANDOVER_BUDGET, statementTimeoutMs: AGENT_HANDOVER_BUDGET.statementTimeoutMs + 1 },
        "postgres",
      ),
    ).toThrow();
  });

  test("every field is one the providers will accept, so the replay cannot be refused before it runs", () => {
    // Both engines validate the whole budget before the statement leaves, and refuse
    // the call outright on any field that is not a positive integer.
    expect(() => assertReadOnlyBudget(AGENT_HANDOVER_BUDGET, "sqlite")).not.toThrow();
    expect(Object.isFrozen(AGENT_HANDOVER_BUDGET)).toBe(true);
  });
});

/**
 * The report reserve (the data-analyst design, §1.5). The figures are restated here
 * rather than read back, for the same reason the decision table is: a test that
 * renders a constant into its own expectation proves the constant agrees with itself.
 */
describe("the ending a run keeps back for its report", () => {
  test("the reserve is two model turns and twenty seconds", () => {
    expect(AGENT_REPORT_RESERVE_TURNS).toBe(2);
    expect(AGENT_REPORT_RESERVE_MS).toBe(20_000);
  });

  /**
   * A reserve at or above a ceiling would be crossed before the run had done
   * anything, so every run would open by being told to finish. Asserted per workflow,
   * because the ceilings differ and the reserve does not.
   */
  test.each(workflowTypes)("%s can reach its reserve rather than starting inside it", (workflow) => {
    const budget = AGENT_WORKFLOW_BUDGETS[workflow];
    expect(AGENT_REPORT_RESERVE_TURNS).toBeLessThan(budget.maxModelTurns);
    expect(AGENT_REPORT_RESERVE_MS).toBeLessThan(budget.runDeadlineMs);
  });

  /**
   * The reserved time has to be enough for the one turn it is reserved FOR, and
   * `compose_report` reaches no database — so what it needs is a model call, not a
   * statement. A reserve under the per-call ceiling would be a promise the transport
   * cannot keep; it is not required to exceed it, because the loop clamps the call to
   * whatever is left and a report turn is short.
   */
  test("the reserved time is worth more than a statement's own ceiling", () => {
    for (const workflow of workflowTypes) {
      expect(AGENT_REPORT_RESERVE_MS, workflow).toBeGreaterThan(
        AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets.statementTimeoutMs,
      );
    }
  });
});
