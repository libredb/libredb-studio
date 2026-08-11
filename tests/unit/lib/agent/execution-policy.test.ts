import { describe, expect, test } from "bun:test";
import {
  AGENT_EXECUTION_POLICY,
  AGENT_EXECUTION_PROFILE,
  AGENT_MAX_REPAIR_ATTEMPTS,
  AGENT_MINIMUM_CALL_MS,
  AGENT_RUN_DEADLINE_MS,
} from "@/lib/agent/execution-policy";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import type { ExecutionActor, OperationRequest } from "@/lib/db/operations/policy";
import { createTargetScope, evaluateOperation } from "@/lib/db/operations/policy";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * The agent programme's own `ExecutionPolicy` (#329 T6).
 *
 * The point of these assertions is that the constant is checked against the REAL
 * pipeline rather than against a restatement of it: `isValidPolicy` is private to
 * `policy.ts`, so the only honest way to prove the constant is enforceable is to
 * run a decision through `evaluateOperation` and see that it is not refused with
 * `MALFORMED_POLICY_CONTEXT`.
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

function decide(request: OperationRequest, actor: ExecutionActor) {
  return evaluateOperation({
    registry: createCanonicalOperationRegistry(),
    policy: AGENT_EXECUTION_POLICY,
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

describe("AGENT_EXECUTION_POLICY — accepted by the real pipeline", () => {
  test("a bounded read by an admin is allowed, so the policy is not malformed", () => {
    const decision = decide(readRequest, { sessionId: "s-1", role: "admin", mode: "agent" });

    expect(decision.kind).toBe("allow");
    expect(decision.policyVersion).toBe(AGENT_EXECUTION_POLICY.version);
  });

  test("a bounded read by a plain user is allowed — only /admin is role-gated in this product", () => {
    const decision = decide(readRequest, { sessionId: "s-1", role: "user", mode: "agent" });

    expect(decision.kind).toBe("allow");
  });

  test("the estimating plan inspection is allowed without approval", () => {
    const decision = decide(
      { operationId: "sql.explain.estimate", target: {}, input: { sql: "SELECT id FROM orders" } },
      { sessionId: "s-1", role: "user", mode: "agent" },
    );

    expect(decision.kind).toBe("allow");
  });

  test("the executing plan variant can only ever reach require-approval under this policy", () => {
    const decision = decide(
      { operationId: "sql.explain.analyze", target: {}, input: { sql: "EXPLAIN ANALYZE SELECT id FROM orders" } },
      { sessionId: "s-1", role: "admin", mode: "agent" },
    );

    expect(decision.kind).toBe("require-approval");
  });
});

describe("AGENT_EXECUTION_POLICY — shape", () => {
  test("admits risk class 1, which is what a bounded data read is", () => {
    expect(AGENT_EXECUTION_POLICY.maxRiskClass).toBe(1);
  });

  test("admits only the agent mode — the editor path is not policed by this pipeline", () => {
    expect(AGENT_EXECUTION_POLICY.allowedModes).toEqual(["agent"]);
  });

  test("admits both roles, matching the product's own authorization model", () => {
    expect([...AGENT_EXECUTION_POLICY.allowedRoles].sort()).toEqual(["admin", "user"]);
  });

  test("every budget dimension is a positive whole number", () => {
    for (const [field, value] of Object.entries(AGENT_EXECUTION_POLICY.budgets)) {
      expect(Number.isInteger(value), `${field} must be an integer, got ${String(value)}`).toBe(true);
      expect(value, `${field} must be >= 1`).toBeGreaterThanOrEqual(1);
    }
  });

  test("the version names the policy, so an audit line can be traced to this constant", () => {
    expect(AGENT_EXECUTION_POLICY.version).toMatch(/^agent-read-only\.\d+$/);
  });

  test("the constant and its budgets are frozen, so no caller can widen them in place", () => {
    expect(Object.isFrozen(AGENT_EXECUTION_POLICY)).toBe(true);
    expect(Object.isFrozen(AGENT_EXECUTION_POLICY.budgets)).toBe(true);
    expect(Object.isFrozen(AGENT_EXECUTION_POLICY.allowedRoles)).toBe(true);
    expect(Object.isFrozen(AGENT_EXECUTION_POLICY.allowedModes)).toBe(true);
  });

  test("a result fits a prompt: the row and byte caps are model-sized, not editor-sized", () => {
    expect(AGENT_EXECUTION_POLICY.budgets.maxResultRows).toBeLessThanOrEqual(500);
    expect(AGENT_EXECUTION_POLICY.budgets.maxResultBytes).toBeLessThanOrEqual(512 * 1024);
  });

  test("one statement at a time: the run loop is sequential, so concurrency is 1", () => {
    expect(AGENT_EXECUTION_POLICY.budgets.maxConcurrentExecutions).toBe(1);
  });
});

describe("the run-level constants the tool layer and the run service share", () => {
  test("the execution profile is the agent read-only one, never the shared writable path", () => {
    expect(AGENT_EXECUTION_PROFILE).toBe("agent-read-only");
  });

  test("the minimum viable call fits under the statement ceiling, so admit can never throw on it", () => {
    expect(AGENT_MINIMUM_CALL_MS).toBeGreaterThanOrEqual(1);
    expect(AGENT_MINIMUM_CALL_MS).toBeLessThanOrEqual(AGENT_EXECUTION_POLICY.budgets.statementTimeoutMs);
  });

  test("the wall-clock deadline is larger than the database-time budget it sits outside of", () => {
    expect(AGENT_RUN_DEADLINE_MS).toBeGreaterThan(AGENT_EXECUTION_POLICY.budgets.maxTotalRunMs);
    expect(Number.isInteger(AGENT_RUN_DEADLINE_MS)).toBe(true);
  });

  test("the repair budget is the three attempts the milestone pinned", () => {
    expect(AGENT_MAX_REPAIR_ATTEMPTS).toBe(3);
  });
});
