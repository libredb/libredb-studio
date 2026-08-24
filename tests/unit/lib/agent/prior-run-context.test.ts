import { describe, expect, test } from "bun:test";
import { derivePriorRunContext } from "@/lib/agent/prior-run-context";
import type { AgentEvidenceReference, AgentRunEvent, AgentRunRecord } from "@/lib/agent/types";

/**
 * `derivePriorRunContext` is pure: it assembles the previous run's objective and
 * report from a record. These tests feed it records shaped the way the ledger
 * folds them, with no store and no model behind them.
 */

const ACTOR = { sessionId: "sess_1", role: "admin" } as const;

const EVIDENCE: AgentEvidenceReference = { source: "artifact", correlationId: "corr_1" };

function record(events: readonly AgentRunEvent[], objective = "Compare salaries by hire year"): AgentRunRecord {
  return {
    runId: "arun_prev",
    mode: "agent",
    workflowType: "data-analysis",
    workflowSource: "chosen",
    workflowReading: "unrecorded",
    autoExecute: false,
    status: "succeeded",
    actor: ACTOR,
    connectionId: "conn_1",
    objective,
    createdAtMs: 1,
    updatedAtMs: 2,
    events,
  };
}

function event(kind: AgentRunEvent["kind"], atMs: number, extra: Record<string, unknown>): AgentRunEvent {
  return { kind, atMs, ...extra } as AgentRunEvent;
}

describe("derivePriorRunContext", () => {
  test("carries the previous run's id and objective, and an empty report when it established nothing", () => {
    const context = derivePriorRunContext(record([]));

    expect(context.runId).toBe("arun_prev");
    expect(context.objective).toBe("Compare salaries by hire year");
    expect(context.report).toBe("");
  });

  test("records the answer statement from an answer-composed event", () => {
    const context = derivePriorRunContext(
      record([
        event("answer-composed", 3, {
          sql: "SELECT hire_year, avg(salary) FROM employees GROUP BY hire_year",
          artifact: {
            correlationId: "corr_1",
            runId: "arun_prev",
            operationId: "sql.query.read",
            summary: { rowCount: 2, columnNames: ["hire_year"], elapsedMs: 4 },
          },
          presentation: { kind: "table" },
          handover: "none",
        }),
      ]),
    );

    expect(context.report).toBe("Answer statement: SELECT hire_year, avg(salary) FROM employees GROUP BY hire_year");
  });

  test("numbers the claims of a report-composed event in ledger order", () => {
    const context = derivePriorRunContext(
      record([
        event("report-composed", 3, {
          claims: [
            { claim: "Before 1990 averaged 41k", evidence: [EVIDENCE] },
            { claim: "After 1990 averaged 38k", evidence: [EVIDENCE] },
          ],
        }),
      ]),
    );

    expect(context.report).toBe("Claim 1: Before 1990 averaged 41k\nClaim 2: After 1990 averaged 38k");
  });

  test("records closing prose as its own line", () => {
    const context = derivePriorRunContext(record([event("closing-statement", 3, { text: "Both groups are close." })]));

    expect(context.report).toBe("Closing: Both groups are close.");
  });

  test("joins every kind in the order the ledger produced them", () => {
    const context = derivePriorRunContext(
      record([
        event("answer-composed", 2, {
          sql: "SELECT 1",
          artifact: {
            correlationId: "corr_1",
            runId: "arun_prev",
            operationId: "sql.query.read",
            summary: { rowCount: 1, columnNames: ["?"], elapsedMs: 1 },
          },
          presentation: { kind: "table" },
          handover: "none",
        }),
        event("report-composed", 3, {
          claims: [{ claim: "One row", evidence: [EVIDENCE] }],
        }),
        event("closing-statement", 4, { text: "Done." }),
      ]),
    );

    expect(context.report).toBe("Answer statement: SELECT 1\nClaim 1: One row\nClosing: Done.");
  });

  test("ignores events that are not part of the report, like a context capture", () => {
    const context = derivePriorRunContext(
      record([
        event("context-captured", 2, { fingerprint: "ctx_1", tableCount: 3 }),
        event("report-composed", 3, { claims: [{ claim: "A fact", evidence: [EVIDENCE] }] }),
      ]),
    );

    expect(context.report).toBe("Claim 1: A fact");
  });
});
