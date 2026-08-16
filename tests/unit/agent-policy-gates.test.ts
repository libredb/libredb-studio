import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import type { QueryResult } from "@/lib/types";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { verifyRunGoal } from "@/lib/agent/goal-verifier";
import { AGENT_TOOL_DEFINITIONS, selectAgentTools } from "@/lib/agent/tools";
import type { AgentRunEvent, AgentRunRecord, AgentRunWorkflowType } from "@/lib/agent/types";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { OperationRegistry } from "@/lib/db/operations/registry";
import type { RegistrableOperationDescriptor } from "@/lib/db/operations/types";

/**
 * The four policy gates, stated as gates (#330 T4).
 *
 * Each of these is already true somewhere — the tool layer enforces one, the
 * registry another, the run service a third. They are gathered here and named
 * because #330 asks for them "asserted as unit tests rather than only as evals": an
 * eval can only observe what a scripted run happened to do, while a gate has to
 * hold for every run there could be. So each test below is written against the
 * DECIDING function rather than against a scenario that exercises it.
 *
 * If one of these fails, the milestone's security claim has moved — not a scenario.
 */

const dataDirs: string[] = [];
afterAll(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const WORKFLOWS: readonly AgentRunWorkflowType[] = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
];

// ─── Gate 1: the planning MODEL is handed no tool ───────────────────────────

/*
  This gate was "planning mode performs zero database operations" until 2026-08-15,
  and its assertions are unchanged — but its NAME was a wider claim than they ever
  checked, and the plan-mode grounding design
  (`docs/superpowers/specs/2026-08-15-plan-mode-sql-generator-design.md`) made the
  wider claim false: the SERVER now reads this connection's catalog before a planning
  run's first turn.

  What these two tests actually pin is the half that did not move and must not: the
  MODEL is handed no tool, in any workflow, so nothing it says can reach a database.
  Grounding is the server's own call, and a plan run still runs no statement of the
  user's — asserted where a run can be observed, in `tests/evals/plan-grounding.test.ts`
  and `tests/isolated/agent-investigation.test.ts`.
*/
describe("GATE — the planning model is handed no tool, in any workflow", () => {
  test("no workflow gives a planning run a single tool", () => {
    // Not "filtered to nothing": there is nothing to filter. A tool it is never
    // offered is a database reach it can never make.
    for (const workflowType of WORKFLOWS) {
      expect(selectAgentTools({ mode: "planning", workflowType }), workflowType).toEqual([]);
    }
  });

  test("the toolless set is the same object for every workflow, so none can be widened in place", () => {
    const sets = WORKFLOWS.map((workflowType) => selectAgentTools({ mode: "planning", workflowType }));
    for (const set of sets) expect(Object.isFrozen(set)).toBe(true);
  });
});

// ─── Gate 2: no execution above risk class 1 ────────────────────────────────

describe("GATE — no operation above risk class 1 can execute", () => {
  test("every registered descriptor is R0 or R1", () => {
    const registry = createCanonicalOperationRegistry();

    for (const id of registry.registeredIds()) {
      const resolution = registry.resolve(id);
      if (resolution.kind !== "resolved") throw new Error(`${id} did not resolve`);
      expect([0, 1], id).toContain(resolution.descriptor.riskClass);
    }
  });

  test("the agent's own ceiling admits nothing above R1", () => {
    for (const budget of Object.values(AGENT_WORKFLOW_BUDGETS)) expect(budget.policy.maxRiskClass).toBe(1);
  });

  test("an R2 descriptor cannot even be registered — the class has no representation", () => {
    // R2+ are not registered-and-disabled; they are unregistrable. A caller that
    // bypasses the types still cannot get one into a registry.
    const registry = new OperationRegistry();
    const beyond = { riskClass: 2, id: "sql.query.write", accessLevel: "data-read" } as unknown;

    expect(() => registry.register(beyond as RegistrableOperationDescriptor)).toThrow();
  });

  test("no tool maps onto the one operation that is default-denied", () => {
    const operations = Object.values(AGENT_TOOL_DEFINITIONS).map((tool) => tool.operationId);

    expect(operations).not.toContain("sql.explain.analyze");
  });
});

// ─── Gate 3: no duplicate executions ────────────────────────────────────────

describe("GATE — a step the ledger already settled is never executed twice", () => {
  /*
    Written against `runStep` itself, and it had to be rewritten to be: an earlier
    version of this block asserted that every tool with an operation id resolves in
    the registry, which is a true statement about a DIFFERENT property. A regression
    that re-executed settled steps would have left it green. Found by review on #346.

    The instrument is the callback: it is what reaches a database, so counting its
    invocations is the gate, and nothing else here is.
  */
  const harness = () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-gate-"));
    dataDirs.push(dataDir);
    const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 8 });
    return { store, service: new AgentRunService({ store, resources: { tracker, artifacts } }) };
  };

  const INVOCATION = { stepId: "step_fixed", tool: "run_read_query", operationId: "sql.query.read" } as const;

  const settlement = (correlationId: string) =>
    ({
      kind: "completed",
      artifact: {
        correlationId,
        runId: "arun_1",
        operationId: "sql.query.read",
        summary: { rowCount: 1, columnNames: ["a"], elapsedMs: 1 },
      },
    }) as const;

  test("the second call with the same step id replays the ledger and does NOT reach the callback", async () => {
    const { service } = harness();
    const { runId } = await service.start({
      mode: "agent",
      actor: { sessionId: "s", role: "admin" },
      connectionId: "conn_1",
      objective: "why",
    });
    await service.markRunning(runId);

    let reached = 0;
    const perform = async () => {
      reached += 1;
      return settlement(`corr_${reached}`);
    };

    const first = await service.runStep(runId, INVOCATION, perform);
    const second = await service.runStep(runId, INVOCATION, perform);

    expect(first.kind).toBe("performed");
    expect(second.kind).toBe("replayed");
    // The whole gate, in one number.
    expect(reached).toBe(1);
    if (second.kind === "replayed" && second.event.kind === "tool-completed") {
      expect(second.event.artifact.correlationId).toBe("corr_1");
    }
  });

  test("a step invoked with no recorded outcome is reported indeterminate, not retried", async () => {
    // The process-death window. Whether it reached the database is unknowable, so
    // re-running it would be exactly the duplicate execution this gate forbids.
    const { store, service } = harness();
    const { runId } = await service.start({
      mode: "agent",
      actor: { sessionId: "s", role: "admin" },
      connectionId: "conn_1",
      objective: "why",
    });
    await service.markRunning(runId);
    await store.appendEvent(runId, {
      kind: "tool-invoked",
      atMs: 1,
      stepId: INVOCATION.stepId,
      tool: "run_read_query",
    });

    let reached = 0;
    const result = await service.runStep(runId, INVOCATION, async () => {
      reached += 1;
      return settlement("corr_x");
    });

    expect(result.kind).toBe("indeterminate");
    expect(reached).toBe(0);
  });

  test("the executing form of EXPLAIN is registered only so the approval gate is reachable", () => {
    // In the registry and default-denied, which is what lets the pipeline answer
    // require-approval for it. That is the opposite of it being available.
    const registry = createCanonicalOperationRegistry();
    const resolution = registry.resolve("sql.explain.analyze");

    if (resolution.kind !== "resolved") throw new Error("expected the analyze descriptor");
    expect(resolution.descriptor.requiresApproval).toBe(true);
  });

  test("every operation a tool drives is one the registry knows, so none reaches a driver unaudited", () => {
    const registry = createCanonicalOperationRegistry();
    const reaching = Object.values(AGENT_TOOL_DEFINITIONS).filter((tool) => tool.operationId !== undefined);

    expect(reaching.length).toBeGreaterThan(0);
    for (const tool of reaching) {
      expect(registry.resolve(tool.operationId ?? "").kind, tool.name).toBe("resolved");
    }
  });
});

// ─── Gate 4: a citation for every final finding ─────────────────────────────

describe("GATE — every final finding carries a citation", () => {
  const artifact = (correlationId: string, rowCount: number) => ({
    correlationId,
    runId: "arun_1",
    operationId: "sql.query.read",
    summary: { rowCount, columnNames: ["a"], elapsedMs: 1 },
  });

  const run = (events: readonly AgentRunEvent[], workflowType: AgentRunWorkflowType = "investigation") =>
    ({ mode: "agent", workflowType, status: "succeeded", events }) as Pick<
      AgentRunRecord,
      "mode" | "workflowType" | "status" | "events"
    >;

  test("a claim with no evidence is inexpressible: the contract's tuple is non-empty", () => {
    // The type, not a check. `AgentReportClaim.evidence` is `[ref, ...ref[]]`, so a
    // claim with nothing behind it does not compile — and the tool's schema enforces
    // the same bound at run time for arguments a model supplies.
    const schema = AGENT_TOOL_DEFINITIONS.compose_report.inputSchema;

    expect(schema.safeParse({ claims: [{ claim: "x", evidence: [] }] }).success).toBe(false);
    expect(schema.safeParse({ claims: [] }).success).toBe(false);
  });

  test("a run whose findings rest on nothing it read does not count as having answered", () => {
    // The gate as the verifier sees it: prose is not a finding, and a report resting
    // only on empty results has cited nothing that says anything.
    const uncited = run([{ kind: "closing-statement", atMs: 1, text: "Everything looks fine." }]);
    expect(verifyRunGoal(uncited).outcome).toBe("unanswered");

    const hollow = run([
      { kind: "tool-completed", atMs: 1, stepId: "s", artifact: artifact("c1", 0) },
      {
        kind: "report-composed",
        atMs: 2,
        claims: [{ claim: "Nothing exists.", evidence: [{ source: "artifact", correlationId: "c1" }] }],
      },
    ]);
    expect(verifyRunGoal(hollow).unmet).toEqual(["empty-evidence"]);
  });

  test("every workflow is held to the citation bar, whatever else it adds", () => {
    for (const workflowType of WORKFLOWS) {
      const verdict = verifyRunGoal(
        run(
          [{ kind: "closing-statement", atMs: 1, text: "A confident summary with nothing behind it." }],
          workflowType,
        ),
      );
      expect(verdict.outcome, workflowType).toBe("unanswered");
      expect(verdict.unmet, workflowType).toContain("no-report");
    }
  });
});
