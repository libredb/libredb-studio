import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isFileBased } from "@/lib/db-ui-config";
import type { ManagedConnection } from "@/lib/seed";
import { newMcpCorrelationId, recordMcpDecision, type McpCallRecord } from "../audit";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpConnectionContext,
  type McpToolCall,
} from "../context";
import {
  MCP_READ_ONLY_ANNOTATIONS,
  MCP_RESULT_CAP_BYTES,
  ownWordsError,
  plainResult,
  recordOrRefuse,
  resultBytes,
  type ToolResult,
} from "../output";

/**
 * list_connections (#246): the connections this deployment opted in for MCP that the token's role
 * may use, without credentials and without a server-side file path, paged under the result cap.
 *
 * Connection metadata comes from the operator's seed file, not from anyone who can write to a
 * database, so the result carries no untrusted-content notice. No provider is called, so one audit
 * event records the call, and a call whose event cannot be written answers nothing but the fixed
 * refusal.
 */

export const ListConnectionsInputSchema = z.object({
  environment: z.enum(["all", "development", "staging", "production", "local", "other"]).optional().default("all"),
  offset: z.number().int().min(0).default(0),
});

const ListedConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.string(),
  database: z.string().optional(),
  environment: z.string().optional(),
});

const ListConnectionsOutputSchema = z.object({
  connections: z.array(ListedConnectionSchema),
  total_connections: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
});

export type ListConnectionsInput = z.infer<typeof ListConnectionsInputSchema>;
type ListedConnection = z.infer<typeof ListedConnectionSchema>;

const LIST_CONNECTIONS_TITLE = "List connections";
export const LIST_CONNECTIONS_DESCRIPTION =
  "List the database connections this deployment opted in for MCP that your token's role may use, without credentials. Works for every engine. An empty list means no connection is opted in: an operator adds mcp: true to a seed connection. Pages with offset; has_more and next_offset say when more connections exist.";

/** The file name alone, cut after the last / or \, so no server-side path reaches the client. */
function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function listed(connection: ManagedConnection): ListedConnection {
  const { database, environment } = connection;
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.type,
    ...(database === undefined ? {} : { database: isFileBased(connection.type) ? fileName(database) : database }),
    ...(environment === undefined ? {} : { environment }),
  };
}

/** Connections in seed order from offset while the whole result fits the cap. */
function page(matching: readonly ListedConnection[], offset: number): ToolResult {
  let fitted = plainResult({ connections: [], total_connections: matching.length, has_more: false, next_offset: null });
  for (let index = offset; index < matching.length; index += 1) {
    const more = index + 1 < matching.length;
    const candidate = plainResult({
      connections: matching.slice(offset, index + 1),
      total_connections: matching.length,
      has_more: more,
      next_offset: more ? index + 1 : null,
    });
    if (resultBytes(candidate) > MCP_RESULT_CAP_BYTES) {
      if (index === offset) {
        return ownWordsError(
          `The connection ${matching[index].id} cannot be listed within the 32 KiB result limit on its own. Ask the operator to shorten that seed entry.`,
        );
      }
      return fitted;
    }
    fitted = candidate;
  }
  return fitted;
}

async function listConnections(args: ListConnectionsInput, call: McpToolCall): Promise<ToolResult> {
  const record: McpCallRecord = {
    action: "list_connections",
    user: call.context.caller.username,
    correlationId: newMcpCorrelationId(),
  };
  const visible = await call.context.visibleConnections();
  if (visible === MCP_CONNECTIONS_UNREADABLE) {
    return (
      recordOrRefuse(() => recordMcpDecision(record, "mcp_connections_unreadable")) ??
      ownWordsError(MCP_CONNECTIONS_UNREADABLE_TEXT)
    );
  }
  const matching = visible
    .filter((connection) => args.environment === "all" || connection.environment === args.environment)
    .map(listed);
  const result = page(matching, args.offset);
  return recordOrRefuse(() => recordMcpDecision(record, result.isError ? "mcp_result_too_large" : undefined)) ?? result;
}

export function registerListConnections(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "list_connections",
    {
      title: LIST_CONNECTIONS_TITLE,
      description: LIST_CONNECTIONS_DESCRIPTION,
      inputSchema: ListConnectionsInputSchema,
      outputSchema: ListConnectionsOutputSchema,
      annotations: MCP_READ_ONLY_ANNOTATIONS,
    },
    (args, ctx) => listConnections(args, { context, signal: ctx.mcpReq.signal }),
  );
}
