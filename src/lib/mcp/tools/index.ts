import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { McpConnectionContext, McpReach } from "../context";
import { InspectSchemaInputSchema, registerInspectSchema } from "./inspect-schema";
import { ListConnectionsInputSchema, registerListConnections } from "./list-connections";
import { registerStatementTools } from "./run-statement";
import { MCP_STATEMENT_INPUT_SCHEMAS, type McpStatementTool } from "./statement-arms";

/**
 * Every MCP tool's name: the metadata tools every engine shares, and each statement tool its language's MCP facet
 * declares.
 */
export type McpToolName = "list_connections" | "inspect_schema" | McpStatementTool;

/**
 * The one map from tool name to the zod object that tool registers (#246).
 *
 * The registration below and the route's argument check read the same objects, so the SDK's
 * own input validation and the route's record of it cannot disagree. Its key order is the
 * registration order, which is the order tools/list answers in. The statement tools' entries come from
 * their arms, in record order; a statement tool is registered only while its arm serves an engine
 * (`MCP_STATEMENT_ARMS`), so its entry here can outlive a listing, and on one token's tools/list only while it serves an
 * engine the token reaches.
 *
 * The map is annotated with `McpToolName` rather than read off its own keys, since a statement tool a language declares
 * as data is a branded string (`AgentDeclaredMcpTool`), and the keys of an object literal that spreads a record keyed
 * by a branded string leave the brand out; `statement-arms.test.ts` holds the name types equal.
 */
export const MCP_TOOL_INPUT_SCHEMAS: Readonly<Record<McpToolName, z.ZodObject>> = Object.freeze({
  list_connections: ListConnectionsInputSchema,
  inspect_schema: InspectSchemaInputSchema,
  ...MCP_STATEMENT_INPUT_SCHEMAS,
});

/** An own key of the map, so an inherited name such as toString never reaches a schema. */
export function isMcpToolName(name: unknown): name is McpToolName {
  return typeof name === "string" && Object.hasOwn(MCP_TOOL_INPUT_SCHEMAS, name);
}

/**
 * Without `reach` it registers every serving tool with the read-only hints, the full handler's set; with one, the
 * metadata tools and the statement tools that serve a reached engine, `inspect_schema` with the reach's hints.
 */
export function registerStudioTools(server: McpServer, context: McpConnectionContext, reach?: McpReach): void {
  registerListConnections(server, context);
  registerInspectSchema(server, context, reach);
  registerStatementTools(server, context, reach);
}
