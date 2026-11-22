import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore, AgentRunUnavailableError } from "@/lib/agent/run-store";
import { type AgentToolContext, groundsUnderExecutionProfile, recommendChangeTool } from "@/lib/agent/tools";
import type { AgentRunEvent, AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";
import { answersProse, modelOver, scriptedModel } from "../../../isolated/fixtures/agent-scripted-model";

/**
 * What a run reads off its persisted statement language. Pinned as it was before the run resolver: the truth table of
 * `groundsUnderExecutionProfile`, and every refusal of the SQL statement card in the order it gives them, with and
 * without the worked call a model may be given. The case of a run whose header persists a language no pack serves no
 * longer pins a pre-resolver error: it pins the FND-1 read-time refusal (`AgentRunUnavailableError`, from
 * `runHeaderRefusal` in `run-ledger-ids.ts`) that such a run meets when its ledger is read, in agent and in planning
 * mode.
 */

const dataDirs: string[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const MODES: readonly AgentRunMode[] = ["planning", "agent"];
const WORKFLOWS: readonly AgentRunWorkflowType[] = [
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
];

describe("groundsUnderExecutionProfile", () => {
  test("is true exactly for an agent-mode statement workflow whose context carries a language, sql included", () => {
    const table = Object.fromEntries(
      MODES.flatMap((mode) =>
        WORKFLOWS.flatMap((workflowType) =>
          ([undefined, "sql", "mongo", "kubectl"] as const).map((statementLanguage) => [
            `${mode}/${workflowType}/${statementLanguage ?? "absent"}`,
            groundsUnderExecutionProfile({
              mode,
              workflowType,
              ...(statementLanguage === undefined ? {} : { statementLanguage }),
            } as AgentToolContext),
          ]),
        ),
      ),
    );
    // Only the context's language is read, never its family: an explicit sql answers as mongo and kubectl do,
    // because the run store copies a persisted header as it is.
    expect(Object.keys(table).filter((key) => table[key])).toEqual([
      "agent/investigation/sql",
      "agent/investigation/mongo",
      "agent/investigation/kubectl",
      "agent/query-optimization/sql",
      "agent/query-optimization/mongo",
      "agent/query-optimization/kubectl",
      "agent/database-assessment/sql",
      "agent/database-assessment/mongo",
      "agent/database-assessment/kubectl",
      "agent/data-analysis/sql",
      "agent/data-analysis/mongo",
      "agent/data-analysis/kubectl",
    ]);
    expect(Object.keys(table)).toHaveLength(MODES.length * WORKFLOWS.length * 4);
  });
});

const postgres: DatabaseConnection = { id: "conn_pg", name: "Orders", type: "postgres", createdAt: new Date(0) };
const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

/**
 * The error a run of `workflowType` in `mode` on PostgreSQL throws first when its record persists `language`, and how
 * many model requests it sent before it.
 */
async function firstError(
  mode: AgentRunMode,
  workflowType: AgentRunWorkflowType,
  language: string,
): Promise<{ readonly error: unknown; readonly turns: number }> {
  forgetHeldSnapshots();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-language-pins-"));
  dataDirs.push(dataDir);
  const provider = {
    queryReadOnly: async (): Promise<QueryResult> => ({
      rows: [{ n: 1 }],
      fields: ["n"],
      rowCount: 1,
      executionTime: 1,
    }),
    listContainers: async () => [],
    countObjects: async () => ({}),
    listObjects: async () => [],
    describeObjects: async () => ({ details: [] }),
  } as unknown as DatabaseProvider;
  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const run = await service.start({
    mode,
    workflowType,
    statementLanguage: language as AgentStatementLanguageId,
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: postgres.id,
    objective: "Which customers ordered most?",
  });
  const script = scriptedModel(answersProse("Done."), answersProse("Done."));
  try {
    await runInvestigation(run.runId, {
      service,
      model: await modelOver(script.fetch),
      resources: {
        connection: postgres,
        capabilities,
        labels: TABLE_LABELS,
        registry: createCanonicalOperationRegistry(),
        scope: createTargetScope(postgres.id),
        tracker,
        artifacts,
        deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs, () => 10_000),
        repairs: new AgentRepairLedger(),
        acquireProvider: async () => provider,
      },
    });
  } catch (error) {
    return { error, turns: script.turns.length };
  }
  return { error: undefined, turns: script.turns.length };
}

describe("a run whose header persists a statement language no pack serves", () => {
  test.each([
    ["agent", "investigation"],
    ["agent", "operations"],
    ["planning", "investigation"],
    ["planning", "operations"],
  ] as const)(
    "in %s mode, %s, is refused when its ledger is read, before any model turn",
    async (mode, workflowType) => {
      const { error, turns } = await firstError(mode, workflowType, "cobol");

      if (!(error instanceof AgentRunUnavailableError))
        throw new Error(`expected the read's refusal, got ${String(error)}`);
      expect(error.refusal).toMatchObject({ field: "statementLanguage", reason: "unknown", id: "cobol" });
      expect(turns).toBe(0);
    },
  );
});

/** A context on PostgreSQL, whose record persists no language, for `modelId`. */
function sqlContext(modelId: string): AgentToolContext {
  return {
    runId: "run_g",
    modelId,
    mode: "agent",
    workflowType: "query-optimization",
    actor: { sessionId: "sess_1", role: "user" },
    connection: postgres,
    capabilities,
    labels: TABLE_LABELS,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(postgres.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS["query-optimization"].runDeadlineMs, () => 10_000),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => {
      throw new Error("a recommendation reaches no database");
    },
  };
}

/** A run holding one estimating plan, `cid_plan`. */
const PLANNED: readonly AgentRunEvent[] = [
  {
    kind: "tool-completed",
    atMs: 2,
    stepId: "step_1",
    artifact: {
      correlationId: "cid_plan",
      runId: "run_g",
      operationId: "sql.explain.estimate",
      summary: { rowCount: 2, columnNames: ["plan"], elapsedMs: 3 },
    },
  },
];

const PLAN_CITED = [{ source: "artifact", correlationId: "cid_plan" }];
const UNKNOWN_CITED = [{ source: "artifact", correlationId: "cid_unknown" }];
const INDEX_DDL = "CREATE INDEX orders_customer_idx ON orders (customer)";

/** One call per refusal the SQL statement card gives, each arriving at the first check it fails. */
const RECOMMEND_CALLS: Readonly<Record<string, unknown>> = {
  "a call missing its statement": { change: "index", rationale: "The plan scans orders.", evidence: PLAN_CITED },
  "a call describing the index in parts": {
    table_name: "orders",
    column_name: "customer",
    index_name: "orders_customer_idx",
  },
  "a call whose fault is inside an evidence item": {
    change: "index",
    statement: INDEX_DDL,
    rationale: "The plan scans orders.",
    evidence: [{ source: "artifact", correlationId: 7 }],
  },
  "a call that fails to parse and cites nothing this run read": {
    change: "index",
    rationale: "The plan scans orders.",
    evidence: UNKNOWN_CITED,
  },
  "an index card over a statement that is no CREATE INDEX": {
    change: "index",
    statement: "DROP INDEX orders_customer_idx",
    rationale: "The index is unused.",
    evidence: PLAN_CITED,
  },
  "a mismatched card that also cites nothing this run read": {
    change: "rewrite",
    statement: "UPDATE orders SET customer = 1",
    rationale: "The plan scans orders.",
    evidence: UNKNOWN_CITED,
  },
  "a well-shaped card citing nothing this run read": {
    change: "index",
    statement: INDEX_DDL,
    rationale: "The plan scans orders.",
    evidence: UNKNOWN_CITED,
  },
  "a well-shaped card citing the plan": {
    change: "index",
    statement: INDEX_DDL,
    rationale: "The plan scans orders.",
    evidence: PLAN_CITED,
  },
  "a statement displaced into the change field": {
    change: INDEX_DDL,
    rationale: "The plan scans orders.",
    evidence: PLAN_CITED,
  },
};

/** What each call in `RECOMMEND_CALLS` was answered, per model, as measured before the statement card moved. */
const SQL_CARD_OUTCOMES: Readonly<Record<string, unknown>> = {
  "unmeasured-model-for-tests": {
    "a call missing its statement": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail:
        "the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required) The call is ONE object: {"change": "index", "statement": "<the CREATE INDEX or the rewritten SELECT, as SQL text>", "rationale": "<why it answers the objective>", "evidence": [ ... ]} \u2014 "statement" is that SQL itself, as a plain string in this call; SQL written only in your reply is not part of it. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it.',
    },
    "a call describing the index in parts": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail:
        "the fields that did not match \u2014 change: expected one of index, rewrite; statement: expected string, received nothing \u2014 this field is required; rationale: expected string, received nothing \u2014 this field is required",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 change: expected one of index, rewrite; statement: expected string, received nothing \u2014 this field is required; rationale: expected string, received nothing \u2014 this field is required) This tool does not compose the statement from parts: there is no table, column or index-name field, and the server will not build the SQL for you. Write the statement yourself \u2014 the CREATE INDEX or the rewritten SELECT, as SQL text \u2014 and cite a result this run read. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it.',
    },
    "a call whose fault is inside an evidence item": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail: "the fields that did not match \u2014 evidence.0.correlationId: expected string, received number",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 evidence.0.correlationId: expected string, received number) Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it.',
    },
    "a call that fails to parse and cites nothing this run read": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail:
        "the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required) The call is ONE object: {"change": "index", "statement": "<the CREATE INDEX or the rewritten SELECT, as SQL text>", "rationale": "<why it answers the objective>", "evidence": [ ... ]} \u2014 "statement" is that SQL itself, as a plain string in this call; SQL written only in your reply is not part of it. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it.',
    },
    "an index card over a statement that is no CREATE INDEX": {
      kind: "unavailable",
      reasonCode: "RECOMMENDATION_SHAPE_MISMATCH",
      modelText:
        "That statement is not the kind of change the card claims. An index recommendation must be one CREATE INDEX statement; a rewrite must be one bounded read.",
    },
    "a mismatched card that also cites nothing this run read": {
      kind: "unavailable",
      reasonCode: "RECOMMENDATION_SHAPE_MISMATCH",
      modelText:
        "That statement is not the kind of change the card claims. An index recommendation must be one CREATE INDEX statement; a rewrite must be one bounded read.",
    },
    "a well-shaped card citing nothing this run read": {
      kind: "unavailable",
      reasonCode: "UNVERIFIABLE_EVIDENCE",
      modelText:
        'At least one evidence reference does not match anything this run produced. Cite an artifact this run actually read, or the schema snapshot it captured. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it. (claims.0.evidence.0 does not match anything this run produced \u2014 this run produced cid_plan)',
      detail: "claims.0.evidence.0 does not match anything this run produced \u2014 this run produced cid_plan",
    },
    "a well-shaped card citing the plan": {
      kind: "recommended",
      recommendation: {
        change: "index",
        statement: "CREATE INDEX orders_customer_idx ON orders (customer)",
        rationale: "The plan scans orders.",
        evidence: [
          {
            source: "artifact",
            correlationId: "cid_plan",
          },
        ],
      },
      modelText: "Recommendation recorded: one index, offered to the user and not executed. It is theirs to apply.",
    },
    "a statement displaced into the change field": {
      kind: "recommended",
      recommendation: {
        change: "index",
        statement: "CREATE INDEX orders_customer_idx ON orders (customer)",
        rationale: "The plan scans orders.",
        evidence: [
          {
            source: "artifact",
            correlationId: "cid_plan",
          },
        ],
      },
      modelText: "Recommendation recorded: one index, offered to the user and not executed. It is theirs to apply.",
    },
  },
  "granite4.1:8b": {
    "a call missing its statement": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail:
        "the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required) The call is ONE object: {"change": "index", "statement": "<the CREATE INDEX or the rewritten SELECT, as SQL text>", "rationale": "<why it answers the objective>", "evidence": [ ... ]} \u2014 "statement" is that SQL itself, as a plain string in this call; SQL written only in your reply is not part of it. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it. A call this run could make right now: {"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]}',
    },
    "a call describing the index in parts": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail:
        "the fields that did not match \u2014 change: expected one of index, rewrite; statement: expected string, received nothing \u2014 this field is required; rationale: expected string, received nothing \u2014 this field is required",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 change: expected one of index, rewrite; statement: expected string, received nothing \u2014 this field is required; rationale: expected string, received nothing \u2014 this field is required) This tool does not compose the statement from parts: there is no table, column or index-name field, and the server will not build the SQL for you. Write the statement yourself \u2014 the CREATE INDEX or the rewritten SELECT, as SQL text \u2014 and cite a result this run read. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it. A call this run could make right now: {"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]}',
    },
    "a call whose fault is inside an evidence item": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail: "the fields that did not match \u2014 evidence.0.correlationId: expected string, received number",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 evidence.0.correlationId: expected string, received number) Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it. A call this run could make right now: {"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]}',
    },
    "a call that fails to parse and cites nothing this run read": {
      kind: "unavailable",
      reasonCode: "INVALID_TOOL_INPUT",
      detail:
        "the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required",
      modelText:
        'The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again. (the fields that did not match \u2014 statement: expected string, received nothing \u2014 this field is required) The call is ONE object: {"change": "index", "statement": "<the CREATE INDEX or the rewritten SELECT, as SQL text>", "rationale": "<why it answers the objective>", "evidence": [ ... ]} \u2014 "statement" is that SQL itself, as a plain string in this call; SQL written only in your reply is not part of it. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it. A call this run could make right now: {"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]}',
    },
    "an index card over a statement that is no CREATE INDEX": {
      kind: "unavailable",
      reasonCode: "RECOMMENDATION_SHAPE_MISMATCH",
      modelText:
        'That statement is not the kind of change the card claims. An index recommendation must be one CREATE INDEX statement; a rewrite must be one bounded read. ({"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]})',
      detail:
        '{"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]}',
    },
    "a mismatched card that also cites nothing this run read": {
      kind: "unavailable",
      reasonCode: "RECOMMENDATION_SHAPE_MISMATCH",
      modelText:
        'That statement is not the kind of change the card claims. An index recommendation must be one CREATE INDEX statement; a rewrite must be one bounded read. ({"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]})',
      detail:
        '{"change":"index","statement":"CREATE INDEX <name> ON <table> (<column>)","rationale":"<why this index answers the objective>","evidence":[{"source":"artifact","correlationId":"cid_plan"}]}',
    },
    "a well-shaped card citing nothing this run read": {
      kind: "unavailable",
      reasonCode: "UNVERIFIABLE_EVIDENCE",
      modelText:
        'At least one evidence reference does not match anything this run produced. Cite an artifact this run actually read, or the schema snapshot it captured. Each evidence item is ONE object: {"source":"artifact","correlationId":"<the artifact id a completed step reported>"} for a result this run read, or {"source":"context-snapshot","fingerprint":"<the fingerprint of the schema snapshot this run captured>"} for that inventory. Add "locator" only to point at a part of it. (claims.0.evidence.0 does not match anything this run produced \u2014 this run produced cid_plan)',
      detail: "claims.0.evidence.0 does not match anything this run produced \u2014 this run produced cid_plan",
    },
    "a well-shaped card citing the plan": {
      kind: "recommended",
      recommendation: {
        change: "index",
        statement: "CREATE INDEX orders_customer_idx ON orders (customer)",
        rationale: "The plan scans orders.",
        evidence: [
          {
            source: "artifact",
            correlationId: "cid_plan",
          },
        ],
      },
      modelText: "Recommendation recorded: one index, offered to the user and not executed. It is theirs to apply.",
    },
    "a statement displaced into the change field": {
      kind: "recommended",
      recommendation: {
        change: "index",
        statement: "CREATE INDEX orders_customer_idx ON orders (customer)",
        rationale: "The plan scans orders.",
        evidence: [
          {
            source: "artifact",
            correlationId: "cid_plan",
          },
        ],
      },
      modelText: "Recommendation recorded: one index, offered to the user and not executed. It is theirs to apply.",
    },
  },
};

describe("the SQL statement card's refusals", () => {
  test.each([
    ["a model with no worked examples", "unmeasured-model-for-tests"],
    ["a model given worked examples", "granite4.1:8b"],
  ] as const)("to %s are what they were, in the order parse, card shape, evidence, record", (_name, modelId) => {
    const outcomes: Record<string, unknown> = Object.fromEntries(
      Object.entries(RECOMMEND_CALLS).map(([name, input]) => [
        name,
        recommendChangeTool(sqlContext(modelId), { runId: "run_g", events: PLANNED }, input),
      ]),
    );

    expect(outcomes).toEqual(SQL_CARD_OUTCOMES[modelId] as Record<string, unknown>);
  });
});
