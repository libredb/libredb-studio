import { describe, expect, test } from "bun:test";
import { AGENT_TERMINAL_STATUSES } from "@/lib/agent/types";
import { assertPersistableState } from "@/lib/agent/state-guard";
import type {
  AgentArtifactReference,
  AgentChartSpec,
  AgentContextSnapshot,
  AgentEvidenceReference,
  AgentReportClaim,
  AgentRunEvent,
  AgentRunRecord,
  AgentToolRefusal,
} from "@/lib/agent/types";

// ─── fixtures: one value per durable contract ───────────────────────────────

const ARTIFACT: AgentArtifactReference = {
  correlationId: "4f2c9a10-0000-4000-8000-000000000001",
  runId: "run_1",
  operationId: "sql.query.read",
  summary: { rowCount: 3, columnNames: ["customer", "total"], elapsedMs: 12 },
};

const SNAPSHOT: AgentContextSnapshot = {
  connectionId: "conn_1",
  fingerprint: "sha256-2f0a",
  capturedAtMs: 1_700_000_000_000,
  tables: [
    {
      name: "orders",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimary: true },
        { name: "customer_id", type: "integer", nullable: false, isPrimary: false },
        { name: "total", type: "numeric", nullable: true, isPrimary: false },
      ],
      indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
      rowCount: 412,
    },
  ],
};

const ARTIFACT_EVIDENCE: AgentEvidenceReference = {
  source: "artifact",
  correlationId: ARTIFACT.correlationId,
  locator: "row 1, column total",
};

const SNAPSHOT_EVIDENCE: AgentEvidenceReference = {
  source: "context-snapshot",
  fingerprint: SNAPSHOT.fingerprint,
  locator: "orders.customer_id -> customers.id",
};

const CLAIM: AgentReportClaim = {
  claim: "Three customers each ordered more than 1,000 last month.",
  evidence: [ARTIFACT_EVIDENCE, SNAPSHOT_EVIDENCE],
};

const DENIAL: AgentToolRefusal = { class: "policy-denied", reasonCode: "TARGET_OUT_OF_SCOPE" };
const APPROVAL: AgentToolRefusal = { class: "approval-required", operationId: "sql.explain.analyze" };
const DATABASE_ERROR: AgentToolRefusal = {
  class: "database-error",
  statementFingerprint: "sha256-8e1b",
  message: 'column "totl" does not exist',
};

/**
 * Typed as a total record over the event union's discriminant, so a new event
 * kind cannot be added to `AgentRunEvent` without a fixture here — the compiler
 * is the exhaustiveness check, not a hand-counted number.
 */
const EVENTS: Record<AgentRunEvent["kind"], AgentRunEvent> = {
  "run-started": { kind: "run-started", atMs: 1, mode: "agent" },
  // What drove a stretch of the run. The `operator` provenance is the fixture rather than
  // `bundled` because it is the shape with fields to get wrong, and the one an operator's
  // deployment actually writes.
  "driver-resolved": {
    kind: "driver-resolved",
    atMs: 1,
    modelId: "qwen3:8b",
    provider: "ollama",
    tuning: { origin: "operator", digest: "f".repeat(64) },
  },
  // A call the server turned back, carrying the verifier's own name for what was missing.
  // `shortfall` is optional because the purpose-written notices answer conditions the
  // verifier has no vocabulary for — a run holding two plans and citing neither, say.
  // A sentence the drive said on a turn it refused nothing. With this one the loop has no
  // silent decisions left: a hold, a decline, a reminder and a stop each leave a mark, and a
  // reader can tell a model that ignored an instruction from one that never received it.
  "guidance-issued": { kind: "guidance-issued", atMs: 3, notice: "report-reminder" },
  // What the model said on the turn it stopped without filing anything. The three entries here
  // now cover the three ways a run can produce nothing and each used to look identical from the
  // ledger: the drive turned a call back, a tool declined one, or the model simply stopped.
  "model-stopped-saying": {
    kind: "model-stopped-saying",
    atMs: 2,
    text: "I have finished reviewing the schema.",
  },
  // A ledger-only tool that declined, carrying the code it declined under and nothing of the
  // model's. Its sibling above records what the DRIVE turned back; this records what a TOOL
  // did, which used to be written nowhere at all.
  "call-declined": {
    kind: "call-declined",
    atMs: 2,
    tool: "present_answer",
    reasonCode: "ANSWER_ARTIFACT_UNKNOWN",
  },
  "call-held": {
    kind: "call-held",
    atMs: 2,
    tool: "compose_report",
    reason: 'Call profile_table on "engineering" and then call compose_report again.',
    shortfall: "no-table-profile",
  },
  // Carries the inventory itself: that is what lets a resumed run re-derive its
  // schema context without reading a catalog again (#329 T8), and it only works
  // because the snapshot is as inert as every other contract here.
  "context-captured": {
    kind: "context-captured",
    atMs: 2,
    fingerprint: SNAPSHOT.fingerprint,
    tableCount: SNAPSHOT.tables.length,
    snapshot: SNAPSHOT,
    // And the word the engine used for those rows (#414), which is two strings and
    // therefore as inert as the rest of the entry.
    noun: { singular: "key pattern", plural: "key patterns" },
  },
  "statement-drafted": {
    kind: "statement-drafted",
    atMs: 3,
    stepId: "step-1",
    sql: "SELECT customer, SUM(totl) FROM orders GROUP BY customer",
    rationale: "First draft from the objective alone.",
  },
  "tool-invoked": {
    kind: "tool-invoked",
    atMs: 4,
    stepId: "step-1",
    tool: "read-query",
    operationId: "sql.query.read",
  },
  "tool-refused": { kind: "tool-refused", atMs: 5, stepId: "step-1", refusal: DATABASE_ERROR },
  "tool-completed": { kind: "tool-completed", atMs: 6, stepId: "step-2", artifact: ARTIFACT },
  "report-composed": { kind: "report-composed", atMs: 7, claims: [CLAIM] },
  // The query-optimization template's own artifact. Both sides cite an estimating
  // plan the run produced, and each summary is the SERVER's structural reading of
  // it — no engine text, so nothing untrusted is carried in a durable record.
  "plan-comparison": {
    kind: "plan-comparison",
    atMs: 6,
    before: {
      correlationId: ARTIFACT.correlationId,
      sql: "SELECT * FROM orders WHERE customer_id = 42",
      summary: { access: "full-scan", estimatedRows: 1000, estimatedCost: 210.5 },
    },
    after: {
      correlationId: "4f2c9a10-0000-4000-8000-000000000002",
      sql: "SELECT id, total FROM orders WHERE customer_id = 42",
      summary: { access: "index", estimatedRows: 3, estimatedCost: 8.3 },
    },
  },
  // A change the run proposes and does not make. `statement` is DDL that nothing in
  // this runtime executes; it exists so the user can take it.
  recommendation: {
    kind: "recommendation",
    atMs: 7,
    change: "index",
    statement: "CREATE INDEX orders_customer_id_idx ON orders (customer_id)",
    rationale: "The filtered column has no index, so the plan reads the table whole.",
    evidence: [ARTIFACT_EVIDENCE],
  },
  // The database-assessment template's own artifact: counts, and the findings the
  // SERVER derived from them. Not one value out of any profiled column.
  "table-profiled": {
    kind: "table-profiled",
    atMs: 8,
    // The read that produced the counts, so a claim about the profile can cite it.
    artifact: { ...ARTIFACT, operationId: "sql.table.profile" },
    profile: {
      table: "public.customers",
      depth: "pattern",
      rowCount: 4120,
      columns: [{ column: "email", present: 4118, distinct: 4100, shaped: 4090 }],
      findings: [
        {
          code: "suspected_pii",
          column: "email",
          detail:
            "99% of the values are shaped like an email address. No value was read out of the database to establish this.",
        },
      ],
    },
  },
  // The data-analysis face's own artifact: which result IS the answer, and how it
  // is to be shown. The spec names columns of THAT result and carries no colours,
  // no title and no aggregation — presentation is the app's, and an aggregation
  // here would be one nothing recorded.
  "answer-composed": {
    kind: "answer-composed",
    atMs: 9,
    sql: "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region",
    artifact: ARTIFACT,
    presentation: {
      kind: "chart",
      spec: { type: "bar", x: "customer", y: ["total"], caption: "Net total by region, largest first." },
    },
    handover: "none",
  },
  // The uncited counterpart: what the model said when it did not compose a report.
  // A planning run's whole output is one of these, and it round-trips as plainly as
  // the rest — prose is already the most inert thing a ledger can hold.
  "closing-statement": { kind: "closing-statement", atMs: 8, text: "Start with the salary index." },
  // A plan run's deliverable, and as inert as everything else here: the statement as
  // text, the engine it was written for, and what the server could check about it
  // without running it. `guardViolation` is absent because this draft is a read —
  // the field is present exactly when `readOnly` is false.
  "plan-statement-drafted": {
    kind: "plan-statement-drafted",
    atMs: 8,
    sql: "SELECT total FROM orders",
    dialect: "postgres",
    readOnly: true,
    identifiers: { kind: "checked", unknownTables: [] },
  },
  "run-finished": { kind: "run-finished", atMs: 8, status: "succeeded" },
};

/** `Object.entries` widens the key to `string`; the union is what the loops assert against. */
const EVENT_ENTRIES = Object.entries(EVENTS) as Array<[AgentRunEvent["kind"], AgentRunEvent]>;

const RUN: AgentRunRecord = {
  runId: "run_1",
  thread: { threadId: "run_1", steps: [], text: "" },
  mode: "agent",
  workflowType: "query-optimization",
  workflowSource: "chosen",
  workflowReading: "unrecorded",
  autoExecute: false,
  status: "succeeded",
  actor: { sessionId: "sess_1", role: "user" },
  connectionId: "conn_1",
  objective: "Which customers ordered the most last month?",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_060_000,
  events: Object.values(EVENTS),
};

// ─── the invariant: persisted state is inert ────────────────────────────────

describe("durable agent contracts", () => {
  const contracts: Array<[string, unknown]> = [
    ["run record", RUN],
    ["run event", EVENTS["tool-completed"]],
    ["context snapshot", SNAPSHOT],
    ["artifact reference", ARTIFACT],
    ["evidence reference", ARTIFACT_EVIDENCE],
    ["report claim", CLAIM],
  ];

  test("every contract survives a JSON round trip unchanged", () => {
    for (const [name, contract] of contracts) {
      const restored: unknown = JSON.parse(JSON.stringify(contract));
      expect(restored, name).toEqual(contract);
    }
  });

  test("every run event kind survives a JSON round trip unchanged", () => {
    for (const [kind, event] of EVENT_ENTRIES) {
      expect(JSON.parse(JSON.stringify(event)), kind).toEqual(event);
    }
  });

  test("every contract passes the persistability guard", () => {
    for (const [name, contract] of contracts) {
      expect(() => assertPersistableState(contract, name), name).not.toThrow();
    }
  });

  test("every event's payload is keyed by the kind it is filed under", () => {
    for (const [kind, event] of EVENT_ENTRIES) {
      expect(event.kind).toBe(kind);
    }
  });
});

// ─── what the contracts make impossible ─────────────────────────────────────

describe("contract shapes", () => {
  test("a report claim cannot be composed without evidence", () => {
    // @ts-expect-error — an empty evidence list is inexpressible: a claim with
    // nothing backing it is exactly what the acceptance bar forbids.
    const unevidenced: AgentReportClaim = { claim: "Sales doubled.", evidence: [] };
    expect(unevidenced.evidence).toHaveLength(0);
  });

  test("a policy denial carries a deny code and cannot carry engine text at all", () => {
    // The structural half of "a denial is never fed back to the model as if it
    // were bad SQL": the policy variant has no field an engine message could
    // travel in, so this is a compile-time assertion, not a check on a literal
    // this test wrote itself.
    // @ts-expect-error — `message` is inexpressible on a policy denial.
    const leaky: AgentToolRefusal = { class: "policy-denied", reasonCode: "ROLE_FORBIDDEN", message: "syntax error" };
    expect(leaky.class).toBe("policy-denied");
    expect(DENIAL).toEqual({ class: "policy-denied", reasonCode: "TARGET_OUT_OF_SCOPE" });
  });

  test("an approval requirement is its own outcome, distinct from both", () => {
    // @ts-expect-error — nor may an approval requirement carry engine text.
    const leaky: AgentToolRefusal = { class: "approval-required", operationId: "sql.explain.analyze", message: "x" };
    expect(leaky.class).toBe("approval-required");
    expect(APPROVAL).toEqual({ class: "approval-required", operationId: "sql.explain.analyze" });
  });

  test("only a database error carries the engine's own text and a statement fingerprint", () => {
    expect(DATABASE_ERROR.class).toBe("database-error");
    expect("message" in DATABASE_ERROR).toBe(true);
    expect("statementFingerprint" in DATABASE_ERROR).toBe(true);
  });

  test("a chart spec cannot ask for a histogram, because the run has no bins to show", () => {
    // A histogram is a client-side binning of raw values, so the picture would show
    // something the artifact does not contain. A bucketing wanted is a bucketing the
    // SQL should do — and then it is a bar chart of an aggregate the run can cite.
    // @ts-expect-error — `histogram` is inexpressible, though `DataCharts` offers it.
    const binned: AgentChartSpec = { type: "histogram", x: "total", y: ["total"], caption: "spread" };
    expect(String(binned.type)).toBe("histogram");
  });

  test("a chart spec cannot be composed without a y column", () => {
    // @ts-expect-error — an empty `y` is inexpressible: a chart with nothing on the
    // value axis is a chart of nothing.
    const axisless: AgentChartSpec = { type: "bar", x: "customer", y: [], caption: "nothing" };
    expect(axisless.y).toHaveLength(0);
  });

  test("a chart spec carries no colour, no title, no size and no aggregation", () => {
    const spec = (EVENTS["answer-composed"] as Extract<AgentRunEvent, { kind: "answer-composed" }>).presentation;
    if (spec.kind !== "chart") throw new Error("expected the fixture to carry a chart");

    expect(Object.keys(spec.spec).sort()).toEqual(["caption", "type", "x", "y"]);
  });

  test("a table answer carries no chart spec at all", () => {
    const table: Extract<AgentRunEvent, { kind: "answer-composed" }>["presentation"] = { kind: "table" };
    // @ts-expect-error — the table arm has no `spec`, so a chart cannot ride along
    // on an answer that says it is a table.
    expect(table.spec).toBeUndefined();
  });

  test("the persisted actor is a session and a role, never a policy mode", () => {
    // The policy layer's `mode` vocabulary is its own (src/lib/db/operations/
    // policy.ts): a run records who started it, and the execution mode is
    // supplied by the server when a tool call reaches the pipeline.
    expect(Object.keys(RUN.actor).sort()).toEqual(["role", "sessionId"]);
  });

  test("the terminal statuses are the union's members and nothing else", () => {
    /*
      `AGENT_TERMINAL_STATUSES` is built with `satisfies Record<AgentRunTerminalStatus,
      true>`, so adding a member to the union stops `types.ts` compiling until it is
      named — which is the half a test cannot assert. What this asserts is the other
      half: that the set says what the union says today, and that neither non-terminal
      status has crept into it.

      It matters at one call site in particular. `POST /api/agent/runs` refuses to
      continue a conversation whose predecessor is not terminal, so a status missing
      here is a legitimate follow-up refused with a message that names nothing: the
      caller is told only that the run may not be continued.
    */
    expect([...AGENT_TERMINAL_STATUSES].sort()).toEqual(["cancelled", "failed", "succeeded"]);
    expect(AGENT_TERMINAL_STATUSES.has("queued")).toBe(false);
    expect(AGENT_TERMINAL_STATUSES.has("running")).toBe(false);
  });
});
