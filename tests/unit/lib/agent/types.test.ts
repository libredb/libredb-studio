import { describe, expect, test } from "bun:test";
import { assertPersistableState } from "@/lib/agent/state-guard";
import type {
  AgentArtifactReference,
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
  // Carries the inventory itself: that is what lets a resumed run re-derive its
  // schema context without reading a catalog again (#329 T8), and it only works
  // because the snapshot is as inert as every other contract here.
  "context-captured": {
    kind: "context-captured",
    atMs: 2,
    fingerprint: SNAPSHOT.fingerprint,
    tableCount: SNAPSHOT.tables.length,
    snapshot: SNAPSHOT,
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
  // The uncited counterpart: what the model said when it did not compose a report.
  // A planning run's whole output is one of these, and it round-trips as plainly as
  // the rest — prose is already the most inert thing a ledger can hold.
  "closing-statement": { kind: "closing-statement", atMs: 8, text: "Start with the salary index." },
  "run-finished": { kind: "run-finished", atMs: 8, status: "succeeded" },
};

/** `Object.entries` widens the key to `string`; the union is what the loops assert against. */
const EVENT_ENTRIES = Object.entries(EVENTS) as Array<[AgentRunEvent["kind"], AgentRunEvent]>;

const RUN: AgentRunRecord = {
  runId: "run_1",
  mode: "agent",
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

  test("the persisted actor is a session and a role, never a policy mode", () => {
    // The policy layer's `mode` vocabulary is its own (src/lib/db/operations/
    // policy.ts): a run records who started it, and the execution mode is
    // supplied by the server when a tool call reaches the pipeline.
    expect(Object.keys(RUN.actor).sort()).toEqual(["role", "sessionId"]);
  });
});
