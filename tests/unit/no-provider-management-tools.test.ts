import { describe, expect, test } from "bun:test";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AGENT_EVIDENCE_TOOLS } from "@/lib/agent/languages/index";
import { agentLanguageMcpFacets } from "@/lib/agent/languages/mcp";
import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolDefinition,
  type AgentToolName,
  agentToolDefinition,
} from "@/lib/agent/tools";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { mcpToolInputSchemas } from "@/lib/mcp/tools/index";
import { InspectSchemaInputSchema } from "@/lib/mcp/tools/inspect-schema";
import { ListConnectionsInputSchema } from "@/lib/mcp/tools/list-connections";
import { mcpStatementSurface } from "@/lib/mcp/tools/statement-arms";

/**
 * No agent or MCP tool reaches provider management.
 *
 * Installing, updating, removing, enabling or reloading a provider, updating its trust file and granting it rights are
 * an operator's acts, never a model's: no tool a model or an MCP client can call may reach one, whatever module comes
 * to hold them. So each tool map is held to what it reaches today, and a tool that reaches anything else fails here
 * until it is reviewed:
 *
 * - MCP: every tool is a metadata tool (`list_connections`, `inspect_schema`) or the statement tool of a language arm,
 *   compared by schema identity with the registry so no tool name is written here, and every arm is fenced as a
 *   read-only statement or by its language's admission.
 * - Agent: every tool, in every language's definition for every workflow, drives an operation the canonical registry
 *   resolves to a read at risk class 0 or 1, or is one of the tools that reach no database.
 */

/** The agent tools that name no operation: each records or compares what the run already read, and reads nothing. */
const NO_DATABASE_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "compare_plans",
  "recommend_change",
  "present_answer",
  "compose_report",
]);

const READ_ACCESS = new Set(["metadata-read", "data-read"]);

describe("no agent or MCP tool reaches provider management", () => {
  test("every MCP tool is a metadata tool or a read-only statement tool", () => {
    const arms = mcpStatementSurface().declared;
    const allowed = new Set<unknown>([
      ListConnectionsInputSchema,
      InspectSchemaInputSchema,
      ...arms.map((arm) => arm.inputSchema),
    ]);
    const schemas = Object.values(mcpToolInputSchemas());
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas.filter((schema) => !allowed.has(schema))).toEqual([]);
    const fences = Object.values(agentLanguageMcpFacets())
      .filter((facet) => facet !== null)
      .map((facet) => facet.fence);
    expect(fences.filter((fence) => fence !== "read-only-statement" && fence !== "language-admission")).toEqual([]);
  });

  test("every agent tool drives a registered read operation or reaches no database", () => {
    const registry = createCanonicalOperationRegistry();
    const languages = Object.keys(agentLanguageMcpFacets()) as AgentStatementLanguageId[];
    const workflows = Object.keys(AGENT_WORKFLOW_BUDGETS) as AgentRunWorkflowType[];
    const names = Object.keys(AGENT_TOOL_DEFINITIONS) as AgentToolName[];
    const definitions: AgentToolDefinition[] = [
      ...Object.values(AGENT_TOOL_DEFINITIONS),
      ...languages.flatMap((language) =>
        workflows.flatMap((workflow) => names.map((name) => agentToolDefinition(language, workflow, name))),
      ),
    ];

    /** What a definition reaches, or null when it is a read or a tool that reaches no database. */
    const beyondRead = (definition: AgentToolDefinition): string | null => {
      if (definition.operationId === undefined) {
        return NO_DATABASE_TOOLS.has(definition.name) ? null : `${definition.name}: no operation`;
      }
      const resolution = registry.resolve(definition.operationId);
      if (resolution.kind !== "resolved") return `${definition.name}: ${definition.operationId} does not resolve`;
      const { accessLevel, riskClass } = resolution.descriptor;
      return READ_ACCESS.has(accessLevel) && riskClass <= 1
        ? null
        : `${definition.name}: ${definition.operationId} is ${accessLevel} at risk class ${riskClass}`;
    };

    expect(definitions.length).toBeGreaterThan(names.length);
    expect(definitions.map(beyondRead).filter((finding) => finding !== null)).toEqual([]);
    // An evidence tool is one a report cites, so it has to be a read, never a tool that reaches no database.
    for (const name of Object.keys(AGENT_EVIDENCE_TOOLS) as AgentToolName[]) {
      const definition = AGENT_TOOL_DEFINITIONS[name];
      expect({ name, operationId: definition?.operationId === undefined ? null : "named" }).toEqual({
        name,
        operationId: "named",
      });
      expect(beyondRead(definition)).toBeNull();
    }
  });
});
