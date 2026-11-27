import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isFileBased } from "@/lib/db-ui-config";
import { legacyProviderRefusal } from "@/lib/db/server-catalog";
import type { ManagedConnection } from "@/lib/seed";
import { newMcpCorrelationId, recordMcpDecision, type McpCallRecord } from "../audit";
import { mcpConnectionUnavailable } from "../availability";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpCaller,
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
import {
  type McpStatementSurface,
  type McpStatementTool,
  mcpStatementSurface,
  mcpStatementToolFor,
  mcpWithholdsDatabase,
} from "./statement-arms";

/**
 * list_connections (#246): the connections this deployment opted in for MCP that the token's role
 * may use, without credentials and without a server-side file path, paged under the result cap.
 * Each names its read_tool, the statement tool that serves its engine, read from the same
 * served-engine resolver the tools register and gate on, or null where none does.
 * A connection no MCP open can serve for this caller (`mcpConnectionUnavailable`, `src/lib/mcp/availability.ts`) lists
 * null too, with `unavailable`, the sentence that says why and what an operator changes.
 * A connection whose database setting is a stored value on its engine (a topic filter, a group id),
 * as its language's facet says, lists no database.
 * A connection whose type names no provider this Studio has (FND-1), such as a seed entry of a newer Studio, lists its
 * type as written in `engine`, null in `read_tool` and the refusal's sentence in `unavailable`, and no per-engine fact
 * is read for it, so it lists no database. So does a connection of an engine only a provider package serves, with the
 * server's engine catalog's refusal (`legacyProviderRefusal`), which for a refused package's engine names the refusal
 * codes (C-107).
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

/**
 * One listed connection, whose `read_tool` is one of `tools`, the statement tools of the installed catalog's
 * composition (`mcpStatementSurface`), read when the tool registers rather than when this module loads, and built once
 * per composition (`outputSchemaOf`).
 */
export function listedConnectionSchema(tools: readonly McpStatementTool[]) {
  return z.object({
    id: z.string(),
    name: z.string(),
    engine: z.string(),
    database: z.string().optional(),
    environment: z.string().optional(),
    read_tool: z.enum(tools).nullable(),
    unavailable: z.string().optional(),
  });
}

/** list_connections' output, its rows' `read_tool` one of `tools`. */
function listConnectionsOutputSchema(tools: readonly McpStatementTool[]) {
  return z.object({
    connections: z.array(listedConnectionSchema(tools)),
    total_connections: z.number().int(),
    has_more: z.boolean(),
    next_offset: z.number().int().nullable(),
  });
}

/** Each statement surface's list_connections output schema, built once per surface, as the tool input schemas are. */
const OUTPUT_SCHEMAS = new WeakMap<McpStatementSurface, ReturnType<typeof listConnectionsOutputSchema>>();

/**
 * list_connections' output schema for `surface`, its rows' `read_tool` one of the surface's statement tools: built on
 * the surface's first request and read by every later one.
 */
function outputSchemaOf(surface: McpStatementSurface): ReturnType<typeof listConnectionsOutputSchema> {
  let schema = OUTPUT_SCHEMAS.get(surface);
  if (schema === undefined) {
    schema = listConnectionsOutputSchema(surface.tools);
    OUTPUT_SCHEMAS.set(surface, schema);
  }
  return schema;
}

export type ListConnectionsInput = z.infer<typeof ListConnectionsInputSchema>;
type ListedConnection = z.infer<ReturnType<typeof listedConnectionSchema>>;

const LIST_CONNECTIONS_TITLE = "List connections";
export const LIST_CONNECTIONS_DESCRIPTION =
  "List the database connections this deployment opted in for MCP that your token's role may use, without credentials. Works for every engine. Each connection's read_tool names the tool that runs a statement on it, or is null where inspect_schema is the only read. A connection that carries unavailable cannot be read by any tool, and unavailable says why and what an operator changes. An empty list means no connection is opted in: an operator adds mcp: true to a seed connection. Pages with offset; has_more and next_offset say when more connections exist.";

/** The file name alone, cut after the last / or \, so no server-side path reaches the client. */
function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function listed(connection: ManagedConnection, caller: McpCaller): ListedConnection {
  const { database, environment } = connection;
  const refusal = legacyProviderRefusal(connection.type, "open");
  if (refusal !== null) {
    return {
      id: connection.id,
      name: connection.name,
      engine: connection.type,
      ...(environment === undefined ? {} : { environment }),
      read_tool: null,
      unavailable: refusal.message,
    };
  }
  const unavailable = mcpConnectionUnavailable(caller, connection);
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.type,
    ...(database === undefined || mcpWithholdsDatabase(connection.type)
      ? {}
      : { database: isFileBased(connection.type) ? fileName(database) : database }),
    ...(environment === undefined ? {} : { environment }),
    read_tool: unavailable === null ? mcpStatementToolFor(connection.type) : null,
    ...(unavailable === null ? {} : { unavailable }),
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
    .map((connection) => listed(connection, call.context.caller));
  const result = page(matching, args.offset);
  return recordOrRefuse(() => recordMcpDecision(record, result.isError ? "mcp_result_too_large" : undefined)) ?? result;
}

/**
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function registerListConnections(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "list_connections",
    {
      title: LIST_CONNECTIONS_TITLE,
      description: LIST_CONNECTIONS_DESCRIPTION,
      inputSchema: ListConnectionsInputSchema,
      outputSchema: outputSchemaOf(mcpStatementSurface()),
      annotations: MCP_READ_ONLY_ANNOTATIONS,
    },
    (args, ctx) => listConnections(args, { context, signal: ctx.mcpReq.signal }),
  );
}
