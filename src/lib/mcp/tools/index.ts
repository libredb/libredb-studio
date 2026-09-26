import type { McpServer } from "@modelcontextprotocol/server";
import type { McpConnectionContext } from "../context";
import { InspectSchemaInputSchema, registerInspectSchema } from "./inspect-schema";
import { ListConnectionsInputSchema, registerListConnections } from "./list-connections";
import { RunReadQueryInputSchema, registerRunReadQuery } from "./run-read-query";

/**
 * The one map from tool name to the zod object that tool registers (#246).
 *
 * The registration below and the route's argument check read the same objects, so the SDK's
 * own input validation and the route's record of it cannot disagree. Its key order is the
 * registration order, which is the order tools/list answers in.
 */
export const MCP_TOOL_INPUT_SCHEMAS = {
  list_connections: ListConnectionsInputSchema,
  inspect_schema: InspectSchemaInputSchema,
  run_read_query: RunReadQueryInputSchema,
} as const;

export type McpToolName = keyof typeof MCP_TOOL_INPUT_SCHEMAS;

/** An own key of the map, so an inherited name such as toString never reaches a schema. */
export function isMcpToolName(name: unknown): name is McpToolName {
  return typeof name === "string" && Object.hasOwn(MCP_TOOL_INPUT_SCHEMAS, name);
}

export function registerStudioTools(server: McpServer, context: McpConnectionContext): void {
  registerListConnections(server, context);
  registerInspectSchema(server, context);
  registerRunReadQuery(server, context);
}
