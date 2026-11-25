/**
 * Each agent mode gate answers Studio's grant of its claim, never Studio's review record of it
 * (docs/providers/CONTRACT.md, clause M-83): the agent posture, workflow availability, the MCP served set and arms,
 * and the engine pack resolver read the granted statement language.
 *
 * Under tests/isolated because it replaces `@/lib/db/claim-grants` with `mock.module()` before it imports any gate,
 * which holds only while this file is the first in its bun process to evaluate them. The grant module is the real one
 * with one shipped engine's row of the granted table changed, so every gate below answers differently from its
 * engine's record, and only the grant can be what it read.
 */
import { describe, expect, mock, test } from "bun:test";

const realGrants = { ...(await import("@/lib/db/claim-grants")) };
mock.module("@/lib/db/claim-grants", () => ({
  ...realGrants,
  GRANTED_AGENT_STATEMENT_LANGUAGE: Object.freeze({ ...realGrants.GRANTED_AGENT_STATEMENT_LANGUAGE, postgres: null }),
}));

const { STUDIO_CLAIM_RECORDS } = realGrants;
const { agentPosture } = await import("@/lib/agent/posture");
const { workflowAvailability } = await import("@/lib/agent/agent-manifest");
const { mcpStatementEngines } = await import("@/lib/mcp/tools/served-engines");
const { mcpStatementToolFor } = await import("@/lib/mcp/tools/statement-arms");
const { agentEnginePack } = await import("@/lib/agent/languages/engines");

describe("the agent mode gates", () => {
  test("each agent mode gate answers Studio's grant of its claim, not the record", () => {
    // The record holds the row the planted grant differs from.
    expect(STUDIO_CLAIM_RECORDS.statementLanguage.postgres).toBe("sql");
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
    // MCP serves no statement on it and names no arm for it.
    expect(mcpStatementEngines("sql")).not.toContain("postgres");
    expect(mcpStatementEngines("sql")).toContain("mysql");
    expect(mcpStatementToolFor("postgres")).toBeNull();
    // The engine pack resolver refuses it by name.
    expect(() => agentEnginePack("postgres")).toThrow(
      "no engine pack for postgres: Studio grants it no statement language",
    );
    expect(agentEnginePack("mysql").id).toBe("sql");
  });
});
