/**
 * Each agent mode gate the browser reads answers Studio's grant of its claim, never Studio's review record of it
 * (docs/providers/CONTRACT.md, clause M-83): the agent posture and workflow availability read the granted statement
 * language, and the operations requirement reads the granted agent readings, each from the legacy engine's grants
 * (`legacyEngineGrants`, through `legacyAgentEngine`), which the browser reads by type until M7. The engine pack
 * resolver, the readings `inspect_operations` offers, the run ledger's reading check and the MCP served set and arms
 * read the engine record's grant instead, held by tests/unit/lib/agent/record-grant-readers.test.ts and
 * tests/unit/mcp/record-grant-readers.test.ts.
 *
 * Under tests/isolated because it replaces `@/lib/db/claim-grants` with `mock.module()` before it imports any gate,
 * which holds only while this file is the first in its bun process to evaluate them. The grant module is the real one
 * with shipped engines' legacy grants changed, so every gate below answers differently from its engine's record, and
 * only the grant can be what it read.
 */
import { describe, expect, mock, test } from "bun:test";

const realGrants = { ...(await import("@/lib/db/claim-grants")) };
/** The legacy grants planted over the real ones, by engine: postgres granted no language, two engines no reading. */
const PLANTED: Readonly<Record<string, object>> = Object.freeze({
  postgres: Object.freeze({ statementLanguage: null }),
  mongodb: Object.freeze({ agentReadings: Object.freeze([]) }),
  kafka: Object.freeze({ agentReadings: Object.freeze([]) }),
});
mock.module("@/lib/db/claim-grants", () => ({
  ...realGrants,
  legacyEngineGrants: (id: string) =>
    Object.hasOwn(PLANTED, id)
      ? Object.freeze({ ...realGrants.legacyEngineGrants(id), ...PLANTED[id] })
      : realGrants.legacyEngineGrants(id),
}));

const { legacyRegisterTable } = await import("../helpers/legacy-register");
const { agentPosture } = await import("@/lib/agent/posture");
const { legacyAgentEngine, operationsWorkflowOpens, workflowAvailability } = await import("@/lib/agent/agent-manifest");

describe("the agent mode gates", () => {
  test("each agent mode gate answers Studio's grant of its claim, not the record", () => {
    // The record holds the row the planted grant differs from.
    expect(legacyRegisterTable("statementLanguage").postgres).toBe("sql");
    // Vacuity: mysql, whose grant is its record's row, still speaks sql at every gate.
    expect(workflowAvailability("agent", "data-analysis", legacyAgentEngine("mysql"))).toMatchObject({ open: true });

    // The posture is the unsupported one, availability refuses the language postgres still requests as not reviewed,
    // and plan mode persists no language.
    expect(agentPosture({ mode: "agent", engine: "postgres", engineLabel: "PostgreSQL", handover: false }).title).toBe(
      "Agent mode has no read-only statement path on PostgreSQL",
    );
    expect(workflowAvailability("agent", "data-analysis", legacyAgentEngine("postgres"))).toEqual({
      open: false,
      cause: "not-reviewed",
    });
    expect(workflowAvailability("planning", "data-analysis", legacyAgentEngine("postgres"))).toEqual({
      open: true,
      statementLanguage: null,
      variant: null,
    });

    // The records hold the readings the planted grants take away.
    expect(legacyRegisterTable("agentReadings").mongodb?.length).toBeGreaterThan(0);
    expect(legacyRegisterTable("agentReadings").kafka).toEqual(["health"]);
    // The operations workflow does not open on an engine granted no reading, and refuses with the requirement's
    // sentence; one granted its readings still opens.
    expect(operationsWorkflowOpens(legacyAgentEngine("mongodb"))).toBe(false);
    expect(operationsWorkflowOpens(legacyAgentEngine("kafka"))).toBe(false);
    expect(operationsWorkflowOpens(legacyAgentEngine("mysql"))).toBe(true);
    expect(workflowAvailability("agent", "operations", legacyAgentEngine("mongodb"))).toEqual({
      open: false,
      cause: "requirement-unmet",
      sentence: expect.stringContaining("Agent mode takes no operational reading on this engine"),
    });
  });
});
