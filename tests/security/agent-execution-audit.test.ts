import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getServerAuditBuffer } from "@/lib/audit";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import type { ExecutionBudget } from "@/lib/db/operations/budgets";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { DENY_REASONS, executeAuditedOperation } from "@/lib/db/operations/execution";
import type { ExecutionActor, ExecutionPolicy, OperationRequest } from "@/lib/db/operations/policy";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * Control 3.5 — accountability of the agent execution path (#328).
 *
 * Two threats, one suite:
 *
 * (a) An execution nobody can see. An agent path whose denials are silent
 *     tells an operator nothing about what was attempted, and an allowed
 *     execution that is unauditable must not run at all — the fail-closed
 *     direction, asserted here by breaking the sink.
 * (b) The audit trail itself becoming the leak. Everything reaching this layer
 *     — statement text, agent-supplied operation ids, session identifiers,
 *     driver error messages — is exactly what `src/lib/audit.ts` forbids
 *     recording. The sentinel sweep below scans the WHOLE serialized output of
 *     both destinations (ring buffer and the authoritative stdout line) rather
 *     than naming fields, so a value smuggled into a field this test never
 *     heard of still fails it.
 */

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

/** Distinctive values that must never appear in either audit destination. */
const SQL_SENTINEL = "zt7q_salary_column_sentinel";
const SESSION_SENTINEL = "eyJhbGciOiJIUzI1NiJ9.sentinel-session-token";
const OPERATION_SENTINEL = "sql.query.read.zt7q_forged_operation";

const actor: ExecutionActor = { sessionId: SESSION_SENTINEL, role: "user", mode: "agent" };
const scope = createTargetScope("conn-1");

function params(request: OperationRequest) {
  return { registry: createCanonicalOperationRegistry(), policy, actor, scope, request, capabilities };
}

function context() {
  return {
    runId: "run-1",
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 8 }),
    clock: (() => {
      let tick = 0;
      return () => {
        tick += 10;
        return tick;
      };
    })(),
  };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

/** Everything both destinations recorded, as one string to scan. */
function auditedText(): string {
  const lines = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
  return `${JSON.stringify(getServerAuditBuffer().getAll())}\n${lines}`;
}

beforeEach(() => {
  getServerAuditBuffer().clear();
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe("agent execution audit — what must never be recorded", () => {
  test("an allowed execution records no statement text and no session identifier", async () => {
    await executeAuditedOperation(
      params({ operationId: "sql.query.read", target: {}, input: { sql: `SELECT ${SQL_SENTINEL} FROM staff` } }),
      context(),
      mock(async () => ({ rows: [{ [SQL_SENTINEL]: 90_000 }] })),
    );

    const recorded = auditedText();
    expect(recorded).not.toContain(SQL_SENTINEL);
    expect(recorded).not.toContain(SESSION_SENTINEL);
    // The result rows stay in the in-memory artifact; only the correlation id
    // and the elapsed time describe them in the log.
    expect(recorded).toContain("agent_operation");
  });

  test("a denied request records neither its statement nor the operation id it invented", async () => {
    await executeAuditedOperation(
      params({ operationId: OPERATION_SENTINEL, target: {}, input: { sql: `SELECT ${SQL_SENTINEL}` } }),
      context(),
      mock(async () => ({ rows: [] })),
    );

    const recorded = auditedText();
    expect(recorded).not.toContain(SQL_SENTINEL);
    expect(recorded).not.toContain(SESSION_SENTINEL);
    // An agent-chosen id is caller text, so it is refused a place in the log
    // exactly like the statement is - the reason code says what happened.
    expect(recorded).not.toContain("zt7q_forged_operation");
    expect(recorded).toContain("agent_unknown_operation");
  });

  test("a provider failure records the typed reason, never the driver's message", async () => {
    await expect(
      executeAuditedOperation(
        params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }),
        context(),
        mock(async () => {
          throw new Error(`relation ${SQL_SENTINEL} does not exist at 10.1.2.3:5432`);
        }),
      ),
    ).rejects.toThrow();

    const recorded = auditedText();
    expect(recorded).not.toContain(SQL_SENTINEL);
    expect(recorded).not.toContain("10.1.2.3");
    expect(recorded).toContain("agent_execution_failed");
  });
});

describe("agent execution audit — what every attempt records", () => {
  test("an allowed execution leaves a decision event and an execution event", async () => {
    const outcome = await executeAuditedOperation(
      params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }),
      context(),
      mock(async () => ({ rows: [] })),
    );

    const [decision, execution] = getServerAuditBuffer().getAll();
    expect(decision.type).toBe("agent_operation");
    expect(execution.type).toBe("agent_operation");
    expect(decision.correlationId).toBe(outcome.correlationId);
    expect(execution.correlationId).toBe(outcome.correlationId);

    // The decision is recorded BEFORE the provider runs, so a statement that
    // never returns still leaves a trace that it was authorized and started.
    expect(decision.target).toBe("agent/operations/decision");
    expect(execution.target).toBe("agent/operations/execution");
    expect(decision.result).toBe("success");
    expect(execution.result).toBe("success");
    expect(decision.reason).toBeUndefined();

    // The action is the registry-RESOLVED id; the actor is a closed-vocabulary
    // label. Neither field can carry caller-supplied text.
    expect(decision.action).toBe("sql.query.read");
    expect(execution.action).toBe("sql.query.read");
    expect(decision.user).toBe("agent:user");
    // Elapsed time comes from the injected clock, not a real one.
    expect(execution.duration).toBe(10);
  });

  test("a denial leaves exactly one event carrying its reason code", async () => {
    const denyingPolicy: ExecutionPolicy = { ...policy, allowedRoles: ["admin"] };
    const outcome = await executeAuditedOperation(
      { ...params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }), policy: denyingPolicy },
      context(),
      mock(async () => ({ rows: [] })),
    );

    const events = getServerAuditBuffer().getAll();
    expect(events).toHaveLength(1);
    expect(events[0].target).toBe("agent/operations/decision");
    expect(events[0].result).toBe("failure");
    expect(events[0].reason).toBe("agent_role_forbidden");
    expect(events[0].correlationId).toBe(outcome.correlationId);
  });

  test("an approval requirement is recorded as its own reason, not as a plain denial", async () => {
    await executeAuditedOperation(
      params({ operationId: "sql.explain.analyze", target: {}, input: { sql: "EXPLAIN ANALYZE SELECT 1" } }),
      context(),
      mock(async () => ({ rows: [] })),
    );

    const events = getServerAuditBuffer().getAll();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("agent_approval_required");
    expect(events[0].action).toBe("sql.explain.analyze");
  });

  test("records that the statement ran even when the artifact store refuses its result", async () => {
    const storeFailure = new Error("artifact store rejected the result");
    const refusingStore = {
      put: () => {
        throw storeFailure;
      },
      releaseRun: () => 0,
    } as unknown as ExecutionArtifactStore;

    // The audit line is emitted BEFORE the in-memory store gets a say. A store
    // that refuses the result must not also erase the record that the database
    // executed something - the trail is the part that cannot be reconstructed.
    await expect(
      executeAuditedOperation(
        params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }),
        { ...context(), artifacts: refusingStore },
        mock(async () => ({ rows: [] })),
      ),
    ).rejects.toThrow(storeFailure);

    const events = getServerAuditBuffer().getAll();
    expect(events).toHaveLength(2);
    expect(events[1].target).toBe("agent/operations/execution");
    expect(events[1].result).toBe("success");
  });

  test("an actor the pipeline never validated is recorded as unknown", async () => {
    await executeAuditedOperation(
      {
        ...params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }),
        actor: { sessionId: SESSION_SENTINEL, role: "root" as never, mode: "agent" },
      },
      context(),
      mock(async () => ({ rows: [] })),
    );

    const [event] = getServerAuditBuffer().getAll();
    expect(event.reason).toBe("agent_invalid_actor");
    // Not "agent:root": the label is built only from values policy.ts accepted.
    expect(event.user).toBe("agent:unknown");
  });
});

describe("agent execution audit — the authoritative stdout line", () => {
  test("carries the correlation id joining an execution's two events", async () => {
    const outcome = await executeAuditedOperation(
      params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }),
      context(),
      mock(async () => ({ rows: [] })),
    );

    const lines = consoleSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.schema).toBe("libredb.audit.v1");
      expect(line.event).toBe("agent_operation");
      expect(line.correlation_id).toBe(outcome.correlationId);
      expect(line.actor).toBe("agent:user");
    }
    expect(lines[0].route).toBe("agent/operations/decision");
    expect(lines[1].route).toBe("agent/operations/execution");
  });

  test("omits the correlation id entirely for events that do not carry one", async () => {
    // Regression guard for the optional-field convention in toAuditLine: a
    // non-agent event must not gain a null or empty correlation_id key, which
    // would change the fixed shape downstream parsers depend on.
    const { emitAuditEvent } = await import("@/lib/audit");
    emitAuditEvent({
      type: "logout",
      action: "logout",
      target: "POST /api/auth/logout",
      user: "admin",
      result: "success",
    });

    const line = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect("correlation_id" in line).toBe(false);
  });
});

describe("agent execution audit — fail closed", () => {
  test("does not invoke the provider when the decision cannot be recorded", async () => {
    const invoke = mock(async () => ({ rows: [] }));
    // The sink is forced to throw to pin a structural property, not to model a
    // specific outage: `emitAuditEvent` is called with no try/catch around it
    // and before the provider, so ANY emission failure stops the execution
    // instead of letting it run unrecorded. (`src/proxy.ts` makes the opposite
    // trade for a 403 it has already decided; tests/api/auth/login.test.ts pins
    // that one with the same forced-sink technique.)
    consoleSpy.mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });

    await expect(
      executeAuditedOperation(
        params({ operationId: "sql.query.read", target: {}, input: { sql: "SELECT 1" } }),
        context(),
        invoke,
      ),
    ).rejects.toThrow("audit sink unavailable");

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("agent execution audit — the deny vocabulary", () => {
  test("maps every policy deny code to a distinct agent reason code", () => {
    const codes = Object.keys(DENY_REASONS);
    const reasons = Object.values(DENY_REASONS);

    // Totality is enforced by the compiler (Record<PolicyDenyCode, AuditReason>);
    // what a test can still add is that the mapping is injective and namespaced,
    // so two different denials never read identically in the log.
    expect(new Set(reasons).size).toBe(codes.length);
    expect(reasons.every((reason) => reason.startsWith("agent_"))).toBe(true);
    expect(codes.length).toBeGreaterThanOrEqual(13);
  });
});
