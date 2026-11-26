/**
 * Each agent mode gate that reads a granted table answers Studio's grant of its claim, never Studio's review record of
 * it (docs/providers/CONTRACT.md, clause M-83): the agent posture and workflow availability read the granted statement
 * language, and the operations requirement reads the granted agent readings. Those are the browser modules' tables,
 * until M7. The engine pack resolver, the readings `inspect_operations` offers, the run ledger's reading check and the
 * MCP served set and arms read the engine record's grant instead, held by
 * tests/unit/lib/agent/record-grant-readers.test.ts and tests/unit/mcp/record-grant-readers.test.ts.
 *
 * Under tests/isolated because it replaces `@/lib/db/claim-grants` with `mock.module()` before it imports any gate,
 * which holds only while this file is the first in its bun process to evaluate them. The grant module is the real one
 * with shipped engines' rows of the two granted tables changed, so every gate below answers differently from its
 * engine's record, and only the grant can be what it read.
 */
import { describe, expect, mock, test } from "bun:test";

const realGrants = { ...(await import("@/lib/db/claim-grants")) };
mock.module("@/lib/db/claim-grants", () => ({
  ...realGrants,
  GRANTED_AGENT_STATEMENT_LANGUAGE: Object.freeze({ ...realGrants.GRANTED_AGENT_STATEMENT_LANGUAGE, postgres: null }),
  GRANTED_AGENT_READINGS: Object.freeze({
    ...realGrants.GRANTED_AGENT_READINGS,
    mongodb: Object.freeze([] as const),
    kafka: Object.freeze([] as const),
  }),
}));

const { legacyRegisterTable } = await import("../helpers/legacy-register");
const { agentPosture } = await import("@/lib/agent/posture");
const { operationsWorkflowOpens, workflowAvailability } = await import("@/lib/agent/agent-manifest");

describe("the agent mode gates", () => {
  test("each agent mode gate answers Studio's grant of its claim, not the record", () => {
    // The record holds the row the planted grant differs from.
    expect(legacyRegisterTable("statementLanguage").postgres).toBe("sql");
    // Vacuity: mysql, whose grant is its record's row, still speaks sql at every gate.
    expect(workflowAvailability("agent", "data-analysis", "mysql")).toMatchObject({ open: true });

    // The posture is the unsupported one, availability has no adapter, and plan mode persists no language.
    expect(agentPosture({ mode: "agent", engine: "postgres", engineLabel: "PostgreSQL", handover: false }).title).toBe(
      "Agent mode has no read-only statement path on PostgreSQL",
    );
    expect(workflowAvailability("agent", "data-analysis", "postgres")).toEqual({ open: false, cause: "no-adapter" });
    expect(workflowAvailability("planning", "data-analysis", "postgres")).toEqual({
      open: true,
      statementLanguage: null,
      variant: null,
    });

    // The records hold the readings the planted grants take away.
    expect(legacyRegisterTable("agentReadings").mongodb?.length).toBeGreaterThan(0);
    expect(legacyRegisterTable("agentReadings").kafka).toEqual(["health"]);
    // The operations workflow does not open on an engine granted no reading, and refuses with the requirement's
    // sentence; one granted its readings still opens.
    expect(operationsWorkflowOpens("mongodb")).toBe(false);
    expect(operationsWorkflowOpens("kafka")).toBe(false);
    expect(operationsWorkflowOpens("mysql")).toBe(true);
    expect(workflowAvailability("agent", "operations", "mongodb")).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence: expect.stringContaining("Agent mode takes no operational reading on this engine"),
    });
  });
});
