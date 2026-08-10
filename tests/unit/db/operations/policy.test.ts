import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ExecutionBudget, ExecutionUsage } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { OperationRegistry } from "@/lib/db/operations/registry";
import { TargetScopeError, createTargetScope, evaluateOperation, executeWithPolicy } from "@/lib/db/operations/policy";
import type {
  ExecutionActor,
  ExecutionPolicy,
  OperationRequest,
  PolicyDecision,
  PolicyDenyCode,
  PolicyEvaluationParams,
  TargetScope,
} from "@/lib/db/operations/policy";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const budgets: ExecutionBudget = {
  maxConcurrentExecutions: 2,
  maxStatementsPerRun: 10,
  maxTotalRunMs: 60_000,
  statementTimeoutMs: 5_000,
  maxResultRows: 1_000,
  maxResultBytes: 1_048_576,
};

const policy: ExecutionPolicy = {
  version: "test-policy.1",
  maxRiskClass: 1,
  allowedRoles: ["admin", "user"],
  allowedModes: ["agent"],
  budgets,
};

const actor: ExecutionActor = { sessionId: "session-1", role: "user", mode: "agent" };

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

const idleUsage: ExecutionUsage = { activeExecutions: 0, executedStatements: 0, totalElapsedMs: 0 };

const readRequest: OperationRequest = {
  operationId: "sql.query.read",
  target: {},
  input: { sql: "SELECT 1" },
};

function params(overrides: Partial<PolicyEvaluationParams> = {}): PolicyEvaluationParams {
  return {
    registry: createCanonicalOperationRegistry(),
    policy,
    actor,
    scope: createTargetScope("conn-1"),
    request: readRequest,
    capabilities,
    usage: idleUsage,
    ...overrides,
  };
}

function expectDeny(decision: PolicyDecision, reasonCode: PolicyDenyCode): void {
  expect(decision.kind).toBe("deny");
  if (decision.kind === "deny") expect(decision.reasonCode).toBe(reasonCode);
}

// ─── Allow path ─────────────────────────────────────────────────────────────

describe("evaluateOperation — allow", () => {
  test("allows a valid bounded read with reason code, policy version, effective budget, and validated input", () => {
    const decision = evaluateOperation(params());
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.reasonCode).toBe("ALLOWED");
      expect(decision.operationId).toBe("sql.query.read");
      expect(decision.policyVersion).toBe("test-policy.1");
      expect(decision.effectiveBudget).toEqual(budgets);
      expect(Object.isFrozen(decision.effectiveBudget)).toBe(true);
      expect(decision.validatedInput).toEqual({ sql: "SELECT 1" });
    }
  });

  test("a caller-named target inside the scope is allowed; absent target fields defer to the server-injected scope", () => {
    const scoped = params({
      scope: createTargetScope("conn-1", { catalogs: ["main"], schemas: ["public"] }),
      request: { ...readRequest, target: { connectionId: "conn-1", catalog: "main", schema: "public" } },
    });
    expect(evaluateOperation(scoped).kind).toBe("allow");
    const unrestricted = params({ request: { ...readRequest, target: { catalog: "anything" } } });
    expect(evaluateOperation(unrestricted).kind).toBe("allow");
    const noTarget = params({ request: { operationId: "sql.query.read", input: { sql: "SELECT 1" } } });
    expect(evaluateOperation(noTarget).kind).toBe("allow");
  });

  test("the effective budget is a snapshot — mutating the policy afterwards never changes an issued decision", () => {
    const localPolicy: ExecutionPolicy = { ...policy, budgets: { ...budgets } };
    const decision = evaluateOperation(params({ policy: localPolicy }));
    (localPolicy.budgets as { maxResultRows: number }).maxResultRows = 999_999;
    if (decision.kind === "allow") expect(decision.effectiveBudget.maxResultRows).toBe(1_000);
    expect(decision.kind).toBe("allow");
  });
});

// ─── Stage 0: classification ────────────────────────────────────────────────

describe("evaluateOperation — classification", () => {
  test("denies an unknown operation id with the registry's reason code and full decision envelope", () => {
    const decision = evaluateOperation(params({ request: { ...readRequest, operationId: "sql.query.write" } }));
    expectDeny(decision, "UNKNOWN_OPERATION");
    expect(decision.policyVersion).toBe("test-policy.1");
    expect(decision.effectiveBudget).toEqual(budgets);
  });

  test("denies an alias-shaped id as ambiguous — never helpfully corrected", () => {
    const decision = evaluateOperation(params({ request: { ...readRequest, operationId: "SQL.Query.Read" } }));
    expectDeny(decision, "AMBIGUOUS_OPERATION");
  });

  test("actor/session precedes classification: an invalid actor wins over an unknown operation (spec-pinned order)", () => {
    const decision = evaluateOperation(
      params({
        request: { ...readRequest, operationId: "nope.op" },
        actor: { ...actor, sessionId: "" },
      }),
    );
    expectDeny(decision, "INVALID_ACTOR");
  });
});

// ─── Stage 1: actor/session ─────────────────────────────────────────────────

describe("evaluateOperation — actor stage", () => {
  test("denies a missing or malformed actor: blank session, unknown role, unknown mode", () => {
    const hostileActors = [
      undefined,
      null,
      { ...actor, sessionId: "" },
      { ...actor, sessionId: "   " },
      { ...actor, sessionId: 42 },
      { ...actor, role: "root" },
      { ...actor, mode: "editor" },
    ];
    for (const hostile of hostileActors) {
      const decision = evaluateOperation(params({ actor: hostile as unknown as ExecutionActor }));
      expectDeny(decision, "INVALID_ACTOR");
    }
  });
});

// ─── Stage 2: immutable target scope ────────────────────────────────────────

describe("evaluateOperation — target scope stage", () => {
  test("denies a caller-chosen connection id that differs from the server-injected scope", () => {
    const decision = evaluateOperation(params({ request: { ...readRequest, target: { connectionId: "conn-2" } } }));
    expectDeny(decision, "TARGET_OUT_OF_SCOPE");
  });

  test("denies a catalog outside the allowlist, and an undeclared catalog when an allowlist exists", () => {
    const scope = createTargetScope("conn-1", { catalogs: ["main"] });
    expectDeny(
      evaluateOperation(params({ scope, request: { ...readRequest, target: { catalog: "other" } } })),
      "TARGET_OUT_OF_SCOPE",
    );
    expectDeny(evaluateOperation(params({ scope, request: readRequest })), "TARGET_OUT_OF_SCOPE");
  });

  test("denies a schema outside the allowlist, and an undeclared schema when an allowlist exists", () => {
    const scope = createTargetScope("conn-1", { schemas: ["public"] });
    expectDeny(
      evaluateOperation(params({ scope, request: { ...readRequest, target: { schema: "pg_catalog" } } })),
      "TARGET_OUT_OF_SCOPE",
    );
    expectDeny(evaluateOperation(params({ scope, request: readRequest })), "TARGET_OUT_OF_SCOPE");
  });

  test("an empty allowlist is deny-all for that dimension", () => {
    const scope = createTargetScope("conn-1", { catalogs: [] });
    expectDeny(
      evaluateOperation(params({ scope, request: { ...readRequest, target: { catalog: "main" } } })),
      "TARGET_OUT_OF_SCOPE",
    );
  });
});

describe("createTargetScope", () => {
  test("returns a deeply frozen scope: the object and both allowlists are immutable", () => {
    const scope = createTargetScope("conn-1", { catalogs: ["main"], schemas: ["public"] });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.catalogAllowlist)).toBe(true);
    expect(Object.isFrozen(scope.schemaAllowlist)).toBe(true);
    expect(scope.connectionId).toBe("conn-1");
  });

  test("later mutation of the caller's allowlist array never reaches the scope", () => {
    const catalogs = ["main"];
    const scope = createTargetScope("conn-1", { catalogs });
    catalogs.push("smuggled");
    expect(scope.catalogAllowlist).toEqual(["main"]);
  });

  test("refuses a blank connection id and blank or non-string allowlist entries", () => {
    expect(() => createTargetScope("")).toThrow(TargetScopeError);
    expect(() => createTargetScope("  ")).toThrow(TargetScopeError);
    expect(() => createTargetScope("conn-1", { catalogs: [""] })).toThrow(TargetScopeError);
    expect(() => createTargetScope("conn-1", { schemas: [" "] })).toThrow(TargetScopeError);
    expect(() => createTargetScope("conn-1", { catalogs: [42 as unknown as string] })).toThrow(TargetScopeError);
  });
});

// ─── Stage 3: schema-validated input ────────────────────────────────────────

describe("evaluateOperation — input stage", () => {
  test("denies input the descriptor schema rejects: missing sql, empty sql, unknown keys, non-object input", () => {
    const hostileInputs = [undefined, null, "SELECT 1", {}, { sql: "" }, { sql: 42 }, { sql: "SELECT 1", extra: true }];
    for (const input of hostileInputs) {
      const decision = evaluateOperation(params({ request: { ...readRequest, input } }));
      expectDeny(decision, "INPUT_VALIDATION_FAILED");
    }
  });
});

// ─── Stage 4: provider capability ───────────────────────────────────────────

describe("evaluateOperation — capability stage", () => {
  const estimateRequest: OperationRequest = { ...readRequest, operationId: "sql.explain.estimate" };

  test("denies an operation whose required capability the provider reports false", () => {
    const decision = evaluateOperation(
      params({ request: estimateRequest, capabilities: { ...capabilities, supportsExplain: false } }),
    );
    expectDeny(decision, "CAPABILITY_UNSUPPORTED");
  });

  test("an absent capability flag is unsupported — fail closed, never a permissive default", () => {
    const { supportsExplain: _dropped, ...withoutExplain } = capabilities;
    const decision = evaluateOperation(
      params({ request: estimateRequest, capabilities: withoutExplain as ProviderCapabilities }),
    );
    expectDeny(decision, "CAPABILITY_UNSUPPORTED");
  });
});

// ─── Stage 5: risk/mode/role policy ─────────────────────────────────────────

describe("evaluateOperation — risk/mode/role stage", () => {
  test("denies a risk class above the policy maximum", () => {
    const decision = evaluateOperation(params({ policy: { ...policy, maxRiskClass: 0 } }));
    expectDeny(decision, "RISK_EXCEEDS_POLICY");
  });

  test("denies a role the policy does not allow", () => {
    const decision = evaluateOperation(params({ policy: { ...policy, allowedRoles: ["admin"] } }));
    expectDeny(decision, "ROLE_FORBIDDEN");
  });

  test("denies a mode the policy does not allow", () => {
    const decision = evaluateOperation(params({ policy: { ...policy, allowedModes: [] } }));
    expectDeny(decision, "MODE_FORBIDDEN");
  });

  test("an approval-flagged descriptor yields require-approval, never a plain allow", () => {
    const decision = evaluateOperation(params({ request: { ...readRequest, operationId: "sql.explain.analyze" } }));
    expect(decision.kind).toBe("require-approval");
    if (decision.kind === "require-approval") {
      expect(decision.reasonCode).toBe("APPROVAL_REQUIRED");
      expect(decision.operationId).toBe("sql.explain.analyze");
      expect(decision.policyVersion).toBe("test-policy.1");
      expect(decision.effectiveBudget).toEqual(budgets);
    }
  });
});

// ─── Stage 6: budgets ───────────────────────────────────────────────────────

describe("evaluateOperation — budget stage", () => {
  test("denies at the concurrency limit and allows just below it", () => {
    expectDeny(
      evaluateOperation(params({ usage: { ...idleUsage, activeExecutions: 2 } })),
      "CONCURRENCY_BUDGET_EXCEEDED",
    );
    expect(evaluateOperation(params({ usage: { ...idleUsage, activeExecutions: 1 } })).kind).toBe("allow");
  });

  test("denies when the run's statement budget is spent and allows the final statement within it", () => {
    expectDeny(
      evaluateOperation(params({ usage: { ...idleUsage, executedStatements: 10 } })),
      "STATEMENT_BUDGET_EXCEEDED",
    );
    expect(evaluateOperation(params({ usage: { ...idleUsage, executedStatements: 9 } })).kind).toBe("allow");
  });

  test("denies when the total-run time budget is exhausted and allows just below it", () => {
    expectDeny(
      evaluateOperation(params({ usage: { ...idleUsage, totalElapsedMs: 60_000 } })),
      "TOTAL_RUN_BUDGET_EXCEEDED",
    );
    expect(evaluateOperation(params({ usage: { ...idleUsage, totalElapsedMs: 59_999.5 } })).kind).toBe("allow");
  });

  test("a budget denial beats require-approval — approval is never a channel around budgets", () => {
    const decision = evaluateOperation(
      params({
        request: { ...readRequest, operationId: "sql.explain.analyze" },
        usage: { ...idleUsage, activeExecutions: 2 },
      }),
    );
    expectDeny(decision, "CONCURRENCY_BUDGET_EXCEEDED");
  });
});

// ─── Malformed server-side context (fail-closed preconditions) ──────────────

describe("evaluateOperation — malformed policy context", () => {
  test("denies on a blank policy version, reporting the version as invalid with an all-zero budget", () => {
    const decision = evaluateOperation(params({ policy: { ...policy, version: "  " } }));
    expectDeny(decision, "MALFORMED_POLICY_CONTEXT");
    expect(decision.policyVersion).toBe("invalid");
    expect(decision.effectiveBudget).toEqual({
      maxConcurrentExecutions: 0,
      maxStatementsPerRun: 0,
      maxTotalRunMs: 0,
      statementTimeoutMs: 0,
      maxResultRows: 0,
      maxResultBytes: 0,
    });
    expect(Object.isFrozen(decision.effectiveBudget)).toBe(true);
  });

  test("denies every non-positive, non-integer, or non-numeric budget field — a NaN limit would otherwise fail open", () => {
    const budgetFields = Object.keys(budgets) as Array<keyof ExecutionBudget>;
    for (const field of budgetFields) {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
        const decision = evaluateOperation(
          params({ policy: { ...policy, budgets: { ...budgets, [field]: bad as unknown as number } } }),
        );
        expectDeny(decision, "MALFORMED_POLICY_CONTEXT");
        expect(decision.policyVersion).toBe("test-policy.1");
      }
    }
  });

  test("denies a policy with unknown roles or modes, or non-array role/mode lists", () => {
    const hostilePolicies = [
      { ...policy, allowedRoles: ["root"] },
      { ...policy, allowedRoles: "admin" },
      { ...policy, allowedModes: ["editor"] },
      { ...policy, allowedModes: "agent" },
      { ...policy, maxRiskClass: 2 },
      { ...policy, budgets: undefined },
      null,
    ];
    for (const hostile of hostilePolicies) {
      const decision = evaluateOperation(params({ policy: hostile as unknown as ExecutionPolicy }));
      expectDeny(decision, "MALFORMED_POLICY_CONTEXT");
    }
  });

  test("denies malformed usage accounting: negative, fractional-count, or non-finite values", () => {
    const hostileUsages = [
      { ...idleUsage, activeExecutions: -1 },
      { ...idleUsage, activeExecutions: 1.5 },
      { ...idleUsage, executedStatements: Number.NaN },
      { ...idleUsage, totalElapsedMs: -5 },
      { ...idleUsage, totalElapsedMs: Number.POSITIVE_INFINITY },
      undefined,
    ];
    for (const hostile of hostileUsages) {
      const decision = evaluateOperation(params({ usage: hostile as unknown as ExecutionUsage }));
      expectDeny(decision, "MALFORMED_POLICY_CONTEXT");
    }
  });

  test("denies a hand-built scope that bypassed createTargetScope with a blank connection id or junk allowlist", () => {
    const hostileScopes = [
      { connectionId: "" },
      { connectionId: "conn-1", catalogAllowlist: ["main", ""] },
      { connectionId: "conn-1", schemaAllowlist: "public" },
      undefined,
    ];
    for (const hostile of hostileScopes) {
      const decision = evaluateOperation(params({ scope: hostile as unknown as TargetScope }));
      expectDeny(decision, "MALFORMED_POLICY_CONTEXT");
    }
  });
});

// ─── Fixed evaluation order ─────────────────────────────────────────────────

describe("evaluateOperation — fixed evaluation order", () => {
  test("fixing each failure surfaces exactly the next stage's denial, ending in allow", () => {
    const registry = new OperationRegistry();
    registry.register({
      id: "test.cascade.read",
      riskClass: 1,
      accessLevel: "data-read",
      requiredCapabilities: ["supportsExplain"],
      resourceCost: "moderate",
      supportsDryRun: false,
      requiresApproval: false,
      inputSchema: z.strictObject({ sql: z.string().min(1) }),
      verification: {
        reviewedBy: "policy pipeline order test",
        boundary: "database-native read-only enforcement (test fixture)",
        verifiedOn: "2026-08-10",
      },
    });
    let p: PolicyEvaluationParams = {
      registry,
      policy: { ...policy, maxRiskClass: 0 },
      actor: { ...actor, sessionId: "" },
      scope: createTargetScope("conn-1", { catalogs: ["main"] }),
      request: { operationId: "test.unknown.op", target: { connectionId: "conn-2", catalog: "other" }, input: {} },
      capabilities: { ...capabilities, supportsExplain: false },
      usage: { activeExecutions: 2, executedStatements: 10, totalElapsedMs: 60_000 },
    };
    const expectStage = (reasonCode: PolicyDenyCode) => expectDeny(evaluateOperation(p), reasonCode);

    expectStage("INVALID_ACTOR");
    p = { ...p, actor };
    expectStage("UNKNOWN_OPERATION");
    p = { ...p, request: { ...p.request, operationId: "test.cascade.read" } };
    expectStage("TARGET_OUT_OF_SCOPE");
    p = { ...p, request: { ...p.request, target: { connectionId: "conn-1", catalog: "main" } } };
    expectStage("INPUT_VALIDATION_FAILED");
    p = { ...p, request: { ...p.request, input: { sql: "SELECT 1" } } };
    expectStage("CAPABILITY_UNSUPPORTED");
    p = { ...p, capabilities };
    expectStage("RISK_EXCEEDS_POLICY");
    p = { ...p, policy };
    expectStage("CONCURRENCY_BUDGET_EXCEEDED");
    p = { ...p, usage: { ...p.usage, activeExecutions: 0 } };
    expectStage("STATEMENT_BUDGET_EXCEEDED");
    p = { ...p, usage: { ...p.usage, executedStatements: 0 } };
    expectStage("TOTAL_RUN_BUDGET_EXCEEDED");
    p = { ...p, usage: idleUsage };
    expect(evaluateOperation(p).kind).toBe("allow");
  });
});

// ─── executeWithPolicy: the spy-provider invariant ──────────────────────────

describe("executeWithPolicy", () => {
  const denyScenarios: ReadonlyArray<[PolicyDenyCode, Partial<PolicyEvaluationParams>]> = [
    ["UNKNOWN_OPERATION", { request: { ...readRequest, operationId: "nope.op" } }],
    ["AMBIGUOUS_OPERATION", { request: { ...readRequest, operationId: "SQL.Query.Read" } }],
    ["MALFORMED_POLICY_CONTEXT", { policy: { ...policy, version: " " } }],
    ["INVALID_ACTOR", { actor: { ...actor, sessionId: "" } }],
    ["TARGET_OUT_OF_SCOPE", { request: { ...readRequest, target: { connectionId: "conn-2" } } }],
    ["INPUT_VALIDATION_FAILED", { request: { ...readRequest, input: {} } }],
    [
      "CAPABILITY_UNSUPPORTED",
      {
        request: { ...readRequest, operationId: "sql.explain.estimate" },
        capabilities: { ...capabilities, supportsExplain: false },
      },
    ],
    ["ROLE_FORBIDDEN", { policy: { ...policy, allowedRoles: [] } }],
    ["MODE_FORBIDDEN", { policy: { ...policy, allowedModes: [] } }],
    ["RISK_EXCEEDS_POLICY", { policy: { ...policy, maxRiskClass: 0 } }],
    ["CONCURRENCY_BUDGET_EXCEEDED", { usage: { ...idleUsage, activeExecutions: 2 } }],
    ["STATEMENT_BUDGET_EXCEEDED", { usage: { ...idleUsage, executedStatements: 10 } }],
    ["TOTAL_RUN_BUDGET_EXCEEDED", { usage: { ...idleUsage, totalElapsedMs: 60_000 } }],
  ];

  test("the provider callback is never invoked on ANY deny", async () => {
    for (const [reasonCode, overrides] of denyScenarios) {
      let calls = 0;
      const outcome = await executeWithPolicy(params(overrides), async () => {
        calls += 1;
        return "never";
      });
      expect(calls).toBe(0);
      expect(outcome.decision.kind).toBe("deny");
      if (outcome.decision.kind === "deny") expect(outcome.decision.reasonCode).toBe(reasonCode);
      expect("result" in outcome).toBe(false);
    }
  });

  test("the provider callback is never invoked on require-approval", async () => {
    let calls = 0;
    const outcome = await executeWithPolicy(
      params({ request: { ...readRequest, operationId: "sql.explain.analyze" } }),
      async () => {
        calls += 1;
        return "never";
      },
    );
    expect(calls).toBe(0);
    expect(outcome.decision.kind).toBe("require-approval");
    expect("result" in outcome).toBe(false);
  });

  test("on allow the callback is invoked exactly once with the validated input and the effective budget", async () => {
    let calls = 0;
    let seenInput: unknown;
    let seenBudget: ExecutionBudget | undefined;
    const outcome = await executeWithPolicy(params(), async (execution) => {
      calls += 1;
      seenInput = execution.validatedInput;
      seenBudget = execution.budget;
      return ["row-1"];
    });
    expect(calls).toBe(1);
    expect(seenInput).toEqual({ sql: "SELECT 1" });
    expect(seenBudget).toEqual(budgets);
    expect(outcome.decision.kind).toBe("allow");
    if ("result" in outcome) expect(outcome.result).toEqual(["row-1"]);
    expect("result" in outcome).toBe(true);
  });

  test("a provider failure propagates — the guard never swallows execution errors", async () => {
    await expect(
      executeWithPolicy(params(), async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");
  });
});
