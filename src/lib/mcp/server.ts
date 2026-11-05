import {
  createMcpHandler,
  McpServer,
  type McpRequestContext,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import { getAppVersion } from "@/lib/app-version";
import { logger } from "@/lib/logger";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpCaller,
  McpConnectionContext,
  mcpCaller,
} from "./context";
import { redactError } from "./serializer";
import { registerStudioTools } from "./tools";

/**
 * The MCP server behind /api/mcp (#246): two handlers for the process, one server per request.
 *
 * createMcpHandler serves the 2026-07-28 revision and, statelessly, the 2025 revisions a default
 * client still speaks, from one factory per handler, and both factories build one identity,
 * capability set, instructions and revision list (`studioServerParts`). The handler performs no
 * Origin, Host or token check of its own; the route in front of it does, and hands the verified
 * identity in as authInfo.
 *
 * A POST whose body is a tools/list goes to `mcpListHandler` (`mcpHandlerFor`), whose factory reads
 * the seed file through its cache to learn which engines the token reaches (`reachableTypes`) and
 * registers the metadata tools and only the statement tools that serve them, with `inspect_schema`'s
 * hints for those engines; it builds no provider and reads no Vault reference. A seed file it cannot
 * read or parse answers that tools/list with JSON-RPC -32603 and `MCP_CONNECTIONS_UNREADABLE_TEXT`,
 * never a list: a shorter one would say there is less to reach, a full one would offer tools no call
 * can use.
 *
 * Every other request, tools/call included, goes to `mcpHandler`, whose factory registers every tool
 * this build serves and only builds objects, its context reading the seed file the first time a tool
 * needs it; so a call to a tool a token's list leaves out still meets Studio's own checks and audit,
 * never the SDK's unknown-tool answer.
 *
 * Nothing ever calls close() on either handler: a closed handler refuses every later request, and
 * the process's own shutdown ends every exchange with it.
 */

export const MCP_SERVER_NAME = "libredb-studio-mcp";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];

export const MCP_INSTRUCTIONS =
  "LibreDB Studio serves the database connections this deployment opted in for MCP, filtered by the role your token carries. Start with list_connections, read a connection's tables with inspect_schema, then run a read with the tool its read_tool names. An empty connection list means no connection is opted in for your role. Every call shares one per-user rate limit with the Studio UI.";

/** The identity, server info and options both factories build a server from. */
function studioServerParts({ authInfo }: McpRequestContext) {
  if (authInfo === undefined) {
    throw new Error("The MCP server factory needs the request's verified identity, and none was passed");
  }
  const version = getAppVersion();
  if (version === null) {
    throw new Error("server version unavailable: NEXT_PUBLIC_APP_VERSION is not set");
  }
  const caller: McpCaller = mcpCaller(authInfo);
  return {
    caller,
    info: { name: MCP_SERVER_NAME, version },
    options: {
      capabilities: { tools: { listChanged: false } },
      instructions: MCP_INSTRUCTIONS,
      supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    },
  };
}

function createStudioMcpServer(ctx: McpRequestContext): McpServer {
  const { caller, info, options } = studioServerParts(ctx);
  const server = new McpServer(info, options);
  registerStudioTools(server, new McpConnectionContext(caller));
  return server;
}

async function createStudioListServer(ctx: McpRequestContext): Promise<McpServer | Server> {
  const { caller, info, options } = studioServerParts(ctx);
  const context = new McpConnectionContext(caller);
  const reach = await context.reachableTypes();
  if (reach === MCP_CONNECTIONS_UNREADABLE) {
    const server = new Server(info, options);
    server.setRequestHandler("tools/list", () => {
      throw new ProtocolError(ProtocolErrorCode.InternalError, MCP_CONNECTIONS_UNREADABLE_TEXT);
    });
    return server;
  }
  const server = new McpServer(info, options);
  registerStudioTools(server, context, reach);
  return server;
}

/**
 * onerror receives the requests the SDK refuses as well as its serving failures, so it reports and
 * never answers: the SDK guarantees it cannot change a response.
 */
function onerror(error: Error): void {
  logger.warn("MCP request refused or failed inside the SDK", { error: redactError(error).message });
}

export const mcpHandler = createMcpHandler(createStudioMcpServer, { legacy: "stateless", onerror });

export const mcpListHandler = createMcpHandler(createStudioListServer, { legacy: "stateless", onerror });

/** The handler for a POST's parsed body: the list handler for a plain tools/list, the full handler for anything else. */
export function mcpHandlerFor(parsedBody: unknown): typeof mcpHandler {
  const listsTools =
    typeof parsedBody === "object" &&
    parsedBody !== null &&
    !Array.isArray(parsedBody) &&
    (parsedBody as { readonly method?: unknown }).method === "tools/list";
  return listsTools ? mcpListHandler : mcpHandler;
}
