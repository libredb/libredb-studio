import { describe, expect, test } from "bun:test";
import { deriveDriveCeilings, tokensSpentIn } from "@/lib/agent/drive-budget";
import { AGENT_PER_TURN_OUTPUT_CAP, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import type { AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";

/** One turn's spend, the shape the drive writes. */
const spent = (inputTokens: number, outputTokens: number): AgentRunEvent => ({
  kind: "model-turn",
  atMs: 1,
  atTurn: 1,
  inputTokens,
  outputTokens,
});

/** An event of another kind, which the token sum must ignore. */
const other: AgentRunEvent = { kind: "run-paused", atMs: 2 };

const WORKFLOWS = Object.keys(AGENT_WORKFLOW_BUDGETS) as AgentRunWorkflowType[];

describe("tokensSpentIn", () => {
  test("sums input and output of every turn entry", () => {
    expect(tokensSpentIn([spent(1200, 300), spent(1500, 100)])).toBe(3100);
  });

  test("is zero for a ledger with no turn entries", () => {
    expect(tokensSpentIn([])).toBe(0);
    expect(tokensSpentIn([other])).toBe(0);
  });

  test("counts a turn with no cached figure exactly like one with a cache hit", () => {
    const withCache: AgentRunEvent = {
      kind: "model-turn",
      atMs: 1,
      atTurn: 1,
      inputTokens: 1000,
      outputTokens: 10,
      cachedInputTokens: 800,
    };
    expect(tokensSpentIn([withCache, spent(1000, 10)])).toBe(2020);
  });
});

describe("deriveDriveCeilings and the token figure", () => {
  const run = (events: readonly AgentRunEvent[]) => ({
    workflowType: "investigation" as const,
    createdAtMs: 1_000,
    events,
  });

  test("reports the run's whole spend, so a resumed drive continues it", () => {
    expect(deriveDriveCeilings(run([spent(1000, 100), spent(2000, 200)]), 2_000).tokensSpent).toBe(3300);
  });

  test("reports zero on a first drive", () => {
    expect(deriveDriveCeilings(run([]), 2_000).tokensSpent).toBe(0);
  });

  test("leaves the ceilings it already derived unchanged", () => {
    const ceilings = deriveDriveCeilings(run([spent(1, 1)]), 2_000);
    expect(ceilings.executedStatements).toBe(0);
    expect(ceilings.executedMs).toBe(0);
    expect(ceilings.artifactAllowance).toBe(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxStatementsPerRun);
    expect(ceilings.deadlineMs).toBe(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs - 1_000);
  });
});

describe("the ceilings every workflow row declares", () => {
  test("a token ceiling is above one turn, so no run is refused before it can answer", () => {
    for (const workflow of WORKFLOWS) {
      const row = AGENT_WORKFLOW_BUDGETS[workflow];
      expect(row.maxTokensPerRun).toBeGreaterThanOrEqual(2 * AGENT_PER_TURN_OUTPUT_CAP);
    }
  });

  test("the per-call cap is a positive whole number", () => {
    expect(Number.isInteger(AGENT_PER_TURN_OUTPUT_CAP)).toBe(true);
    expect(AGENT_PER_TURN_OUTPUT_CAP).toBeGreaterThan(0);
  });

  test("the rows are frozen, so no caller can widen one at runtime", () => {
    expect(Object.isFrozen(AGENT_WORKFLOW_BUDGETS)).toBe(true);
    for (const workflow of WORKFLOWS) expect(Object.isFrozen(AGENT_WORKFLOW_BUDGETS[workflow])).toBe(true);
  });
});
